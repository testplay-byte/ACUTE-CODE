/**
 * Agentic Coding MVP tests: the file-tool sandbox (path containment is a
 * security boundary) and the /projects REST surface.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createDir,
  deleteFile,
  editFile,
  listDir,
  projectTree,
  readFile,
  resolveInsideRoot,
  searchFiles,
  writeFile,
} from "../src/tools/index";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { PROJECT_PALETTE, createProject } from "../src/storage/projects";

let tempDir = "";
let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>>;
const TOKEN = "test-token-9f3a";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-projects-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
});

afterEach(async () => {
  await app.close();
  db.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows handle lag — best effort */
  }
});

describe("file tool sandbox (path containment)", () => {
  it.each([
    ["../escape.txt"],
    ["a/../../escape.txt"],
    ["C:\\Windows\\evil.txt"],
    ["C:/Windows/evil.txt"],
    ["/absolute/path.txt"],
  ])("rejects escape path %j", (bad) => {
    const result = resolveInsideRoot(tempDir, bad);
    expect("error" in result).toBe(true);
  });

  it("resolves plain relative paths inside the root", () => {
    const result = resolveInsideRoot(tempDir, "src/lib/x.ts");
    expect("abs" in result && result.abs.startsWith(tempDir)).toBe(true);
  });

  it("write → list → read → edit round-trips inside the root", () => {
    const write = writeFile(tempDir, "src/hello.ts", "const a = 1;\n");
    expect(write.ok).toBe(true);

    const listing = listDir(tempDir, "src");
    expect(listing.ok).toBe(true);
    expect(listing.output).toContain("hello.ts");

    const read = readFile(tempDir, "src/hello.ts");
    expect(read.ok).toBe(true);
    expect(read.output).toContain("const a = 1;");

    const edit = editFile(tempDir, "src/hello.ts", "const a = 1;", "const a = 2;");
    expect(edit.ok).toBe(true);
    expect(readFileSync(join(tempDir, "src", "hello.ts"), "utf8")).toContain("const a = 2;");
  });

  it("edit fails loudly on missing or ambiguous anchors", () => {
    writeFileSync(join(tempDir, "dup.txt"), "same same\n", "utf8");
    const missing = editFile(tempDir, "dup.txt", "nope", "x");
    expect(missing.ok).toBe(false);
    const ambiguous = editFile(tempDir, "dup.txt", "same", "different");
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain("2 times");
  });

  it("tree skips ignored folders and sorts folders first", () => {
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });
    writeFileSync(join(tempDir, "node_modules", "junk.js"), "x");
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(tempDir, "README.md"), "# hi\n");

    const tree = projectTree(tempDir);
    const names = tree.map((n) => n.name);
    expect(names).not.toContain("node_modules");
    expect(names[0]).toBe("src");
    expect(tree.find((n) => n.name === "src")?.children?.map((c) => c.name)).toEqual(["a.ts"]);
  });
});

describe("/api/v1/projects", () => {
  function authInject(options: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }) {
    return app.inject({
      ...options,
      headers: { authorization: `Bearer ${TOKEN}` },
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
    });
  }

  it("creates a project for an existing folder and lists it", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Acute Test", rootPath: tempDir },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.name).toBe("Acute Test");
    expect(body.rootPath).toBe(tempDir);
    expect(body.id).toMatch(/^acute-test-/);

    const listed = await authInject({ method: "GET", url: "/api/v1/projects" });
    expect(listed.json().projects).toHaveLength(1);
  });

  it("409s when another project already uses the folder", async () => {
    await authInject({ method: "POST", url: "/api/v1/projects", payload: { name: "A", rootPath: tempDir } });
    const second = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "B", rootPath: tempDir },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects a nonexistent folder with 400 VALIDATION", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Ghost", rootPath: join(tempDir, "does-not-exist") },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("does not exist");
  });

  it("serves the explorer tree and file content for the project", async () => {
    mkdirSync(join(tempDir, "lib"), { recursive: true });
    writeFileSync(join(tempDir, "lib", "util.ts"), "export const answer = 42;\n");
    await authInject({ method: "POST", url: "/api/v1/projects", payload: { name: "Tree", rootPath: tempDir } });

    const listed = await authInject({ method: "GET", url: "/api/v1/projects" });
    const id = (listed.json().projects as Array<{ id: string }>)[0].id;

    const tree = await authInject({ method: "GET", url: `/api/v1/projects/${id}/tree` });
    const libNode = (tree.json().tree as Array<{ name: string; children?: unknown[] }>).find(
      (n) => n.name === "lib",
    );
    expect(libNode?.children?.map((c) => (c as { name: string }).name)).toEqual(["util.ts"]);

    const file = await authInject({
      method: "GET",
      url: `/api/v1/projects/${id}/file?path=${encodeURIComponent("lib/util.ts")}`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.json().content).toContain("answer = 42");
  });

  it("delete unregisters the row but leaves files on disk", async () => {
    writeFileSync(join(tempDir, "keep.txt"), "persist me\n", "utf8");
    await authInject({ method: "POST", url: "/api/v1/projects", payload: { name: "Keep", rootPath: tempDir } });
    const listed = await authInject({ method: "GET", url: "/api/v1/projects" });
    const id = (listed.json().projects as Array<{ id: string }>)[0].id;

    const removed = await authInject({ method: "DELETE", url: `/api/v1/projects/${id}` });
    expect(removed.statusCode).toBe(204);
    expect(readFileSync(join(tempDir, "keep.txt"), "utf8")).toContain("persist me");
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
  });
});

describe("round-14 tools: create_dir / delete_file / search_files", () => {
  it("create_dir creates nested folders and stays sandboxed", () => {
    const ok = createDir(tempDir, "pkg/nested/folders");
    expect(ok.ok).toBe(true);
    expect(listDir(tempDir, "pkg/nested").output).toContain("folders");
    const escape = createDir(tempDir, "../outside");
    expect(escape.ok).toBe(false);
  });

  it("delete_file removes one file but refuses directories and escapes", () => {
    writeFile(tempDir, "tmp/a.txt", "x");
    mkdirSync(join(tempDir, "adir"));
    expect(deleteFile(tempDir, "tmp/a.txt").ok).toBe(true);
    expect(readFile(tempDir, "tmp/a.txt").ok).toBe(false);
    const dir = deleteFile(tempDir, "adir");
    expect(dir.ok).toBe(false);
    expect(dir.output).toContain("directory");
    expect(deleteFile(tempDir, "../x").ok).toBe(false);
    expect(deleteFile(tempDir, "").ok).toBe(false); // the root itself
  });

  it("search_files finds paths case-insensitively and respects ignore rules", () => {
    writeFile(tempDir, "src/auth/Login.ts", "x");
    writeFile(tempDir, "src/util/loginHelpers.ts", "x");
    mkdirSync(join(tempDir, "node_modules"));
    writeFileSync(join(tempDir, "node_modules", "login-evil.js"), "x");
    const hits = searchFiles(tempDir, "login");
    expect(hits.ok).toBe(true);
    expect(hits.output).toContain("src/auth/Login.ts");
    expect(hits.output).toContain("src/util/loginHelpers.ts");
    expect(hits.output).not.toContain("node_modules");
    expect(searchFiles(tempDir, "  ").ok).toBe(false);
    expect(searchFiles(tempDir, "zzz-nothing").output).toContain("no paths matching");
  });
});

describe("round-17: tool-name truth + allowedTools enforcement (ADR-0019)", () => {
  it("TOOL_NAMES equals the real seed set (round-28: +index_project; R43-10: +browser_control; R43: +delegate_task; R44-a: +memory tools; R52-a: +job tools; R61: +read_skill)", async () => {
    const { TOOL_NAMES } = await import("../src/storage/agents");
    expect([...TOOL_NAMES].sort()).toEqual([
      "browser_control",
      "create_dir",
      "delegate_task",
      "delete_file",
      "edit_file",
      "git_diff",
      "git_log",
      "git_status",
      "index_project",
      "job_status",
      "job_stop",
      "list_dir",
      "memory_list",
      "memory_recall",
      "memory_save",
      "read_file",
      "read_skill",
      "run_command",
      "search_code",
      "search_files",
      "todo_write",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
  });

  it("buildProjectTools filters by allowlist; empty allowlist = all tools (22 base incl. browser_control + memory + job tools; read_skill is deps-gated per R61 — bare calls don't get it)", async () => {
    const { buildProjectTools } = await import("../src/tools/index");
    // ROUND-36: delegate_task requires deps.keyring + deps.chat — without
    // them the base tools return (back-compat), with them more (R43-10
    // added browser_control; R44-a added the three memory tools; R52-a the
    // two job tools to the base set — they fail gracefully without deps,
    // like todo_write).
    const all = (await buildProjectTools(tempDir)) as unknown as Record<string, unknown>;
    expect(Object.keys(all).sort()).toEqual([
      "browser_control",
      "create_dir",
      "delete_file",
      "edit_file",
      "git_diff",
      "git_log",
      "git_status",
      "index_project",
      "job_status",
      "job_stop",
      "list_dir",
      "memory_list",
      "memory_recall",
      "memory_save",
      "read_file",
      "run_command",
      "search_code",
      "search_files",
      "todo_write",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    const two = (await buildProjectTools(tempDir, ["read_file", "search_files"])) as unknown as Record<string, unknown>;
    expect(Object.keys(two).sort()).toEqual(["read_file", "search_files"]);
    const empty = (await buildProjectTools(tempDir, [])) as unknown as Record<string, unknown>;
    expect(Object.keys(empty)).toHaveLength(22);
  });

  it("server rejects SPEC-era tool names in allowedTools (drift guard)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: "Drift", allowedTools: ["file_read"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ── ROUND-48 (R48-a): per-project colors — palette default + migration 0018 ── */

describe("round-48 project colors", () => {
  it("PROJECT_PALETTE is 8 distinct 6-digit hex colors including the old default orange", () => {
    expect(PROJECT_PALETTE).toHaveLength(8);
    expect(new Set(PROJECT_PALETTE).size).toBe(8);
    for (const color of PROJECT_PALETTE) expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    // The pre-R48 default stays palette[0] so existing tiles never look alien.
    expect(PROJECT_PALETTE[0]).toBe("#FF6B2C");
  });

  it("createProject defaults to the LEAST-USED palette color — consecutive projects come out distinct", () => {
    const mk = (n: number) => createProject(db, { name: `P${n}`, rootPath: join(tempDir, `p${n}`) });
    // Empty table: every palette color unused → palette[0] (the brand orange).
    expect(mk(1).color).toBe("#FF6B2C");
    // Orange is now used once; blue is the first unused color.
    expect(mk(2).color).toBe("#3B82F6");
    expect(mk(3).color).toBe("#14B8A6");
    // The palette runs out on the 9th project — all colors used once →
    // tie → first in palette order.
    for (let n = 4; n <= 8; n++) mk(n);
    expect(mk(9).color).toBe("#FF6B2C");
  });

  it("an explicit input.color still wins over the palette default", () => {
    const custom = createProject(db, { name: "Custom", rootPath: tempDir, color: "#123456" });
    expect(custom.color).toBe("#123456");
  });

  it("POST /projects without a color serves the palette default (fresh db → palette[0])", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: "Palette", rootPath: tempDir },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().color).toBe(PROJECT_PALETTE[0]);
  });
});

describe("migration 0018 (project colors backfill)", () => {
  /** Applies migrations 0001..0017 by hand — simulates a pre-R48 install. */
  function openPreR48Database(path: string): SqliteDatabase {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 17)
      .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
    expect(files).toHaveLength(17);
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (const file of files) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
    }
    return db;
  }

  interface ProjectColorRow {
    id: string;
    color: string;
  }

  it("reassigns legacy default-orange rows round-robin by created_at; custom colors untouched; idempotent", () => {
    const path = join(tempDir, `m0018-${randomUUID()}.db`);
    const old = openPreR48Database(path);
    // Three legacy all-orange rows inserted OUT of created_at order (ids and
    // timestamps disagree — the migration must order by created_at) + one
    // user-set color that must survive.
    const ins = old.prepare(
      "INSERT INTO projects (id, name, root_path, color, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run("prj_c", "C", "/c", "#FF6B2C", "2026-01-03T00:00:00Z");
    ins.run("prj_a", "A", "/a", "#FF6B2C", "2026-01-01T00:00:00Z");
    ins.run("prj_b", "B", "/b", "#FF6B2C", "2026-01-02T00:00:00Z");
    ins.run("prj_x", "X", "/x", "#123456", "2026-01-05T00:00:00Z");
    old.close();

    // Reopen with the current code: 0018 applies inside openDatabase.
    const db2 = openDatabase(path);
    try {
      const colorOf = (id: string) =>
        (db2.prepare("SELECT color FROM projects WHERE id = ?").get(id) as ProjectColorRow).color;
      // Round-robin by created_at (A first): palette[0], [1], [2].
      expect(colorOf("prj_a")).toBe(PROJECT_PALETTE[0]);
      expect(colorOf("prj_b")).toBe(PROJECT_PALETTE[1]);
      expect(colorOf("prj_c")).toBe(PROJECT_PALETTE[2]);
      // The user-set color is untouched.
      expect(colorOf("prj_x")).toBe("#123456");

      // Audit row (shared pattern with 0013/0014).
      const audit = db2
        .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0018' LIMIT 1")
        .get() as { actor: string; action: string };
      expect(audit).toEqual({ actor: "migration-0018", action: "projects.colors.backfill" });
    } finally {
      db2.close();
    }

    // Idempotent: reopening must not reshuffle the backfilled colors.
    const again = openDatabase(path);
    try {
      const colorOf = (id: string) =>
        (again.prepare("SELECT color FROM projects WHERE id = ?").get(id) as ProjectColorRow).color;
      expect(colorOf("prj_a")).toBe(PROJECT_PALETTE[0]);
      expect(colorOf("prj_b")).toBe(PROJECT_PALETTE[1]);
      expect(colorOf("prj_c")).toBe(PROJECT_PALETTE[2]);
    } finally {
      again.close();
    }
  });

  it("wraps the palette when an install has more than 8 legacy rows", () => {
    const path = join(tempDir, `m0018-wrap-${randomUUID()}.db`);
    const old = openPreR48Database(path);
    const ins = old.prepare(
      "INSERT INTO projects (id, name, root_path, color, created_at) VALUES (?, ?, ?, '#FF6B2C', ?)",
    );
    for (let i = 0; i < 10; i++) {
      ins.run(`prj_${i}`, `P${i}`, `/p${i}`, `2026-01-${String(1 + i).padStart(2, "0")}T00:00:00Z`);
    }
    old.close();

    const db2 = openDatabase(path);
    try {
      const rows = db2
        .prepare("SELECT id, color FROM projects ORDER BY created_at")
        .all() as ProjectColorRow[];
      expect(rows).toHaveLength(10);
      // Round-robin: indices 0..7 then wrap — row 8 → palette[0], row 9 → palette[1].
      expect(rows.map((r) => r.color)).toEqual([
        ...PROJECT_PALETTE,
        PROJECT_PALETTE[0],
        PROJECT_PALETTE[1],
      ]);
    } finally {
      db2.close();
    }
  });
});
