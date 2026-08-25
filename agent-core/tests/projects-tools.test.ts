/**
 * Agentic Coding MVP tests: the file-tool sandbox (path containment is a
 * security boundary) and the /projects REST surface.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("TOOL_NAMES equals the real 16-tool set (round-28: +index_project)", async () => {
    const { TOOL_NAMES } = await import("../src/storage/agents");
    expect([...TOOL_NAMES].sort()).toEqual([
      "create_dir",
      "delete_file",
      "edit_file",
      "git_diff",
      "git_log",
      "git_status",
      "index_project",
      "list_dir",
      "read_file",
      "run_command",
      "search_code",
      "search_files",
      "todo_write",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
  });

  it("buildProjectTools filters by allowlist; empty allowlist = all tools (17 incl. delegate_task)", async () => {
    const { buildProjectTools } = await import("../src/tools/index");
    // ROUND-36: delegate_task requires deps.keyring + deps.chat — without
    // them the base 16 tools return (back-compat), with them 17.
    const all = (await buildProjectTools(tempDir)) as unknown as Record<string, unknown>;
    expect(Object.keys(all).sort()).toEqual([
      "create_dir",
      "delete_file",
      "edit_file",
      "git_diff",
      "git_log",
      "git_status",
      "index_project",
      "list_dir",
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
    expect(Object.keys(empty)).toHaveLength(16);
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
