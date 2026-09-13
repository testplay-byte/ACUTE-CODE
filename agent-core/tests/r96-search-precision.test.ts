// @vitest-environment node
//
// ROUND-96 (R96-C): SEARCH PRECISION — the owner's words this suite answers:
//   "Its searching capabilities need to be worked on properly. If it needs to
//    search something in the project, it should utilize smarter techniques
//    rather than checking each and every single one of the files."
// Pins:
//   A. search_code ripgrep semantics: output_mode three ways (content /
//      files_with_matches / count), context lines, the regex flag (+ the
//      legacy '/pattern/' form), the .gitignore-respecting walk (patterns,
//      dir rules, '!' re-includes, per-directory stacking, the root→subdir
//      chain), binary skipping, per-file grouping + truncation flags,
//      file_glob forms.
//   B. search_files: glob patterns ('**' across directories), mtime-desc
//      ordering, the 100-file cap with an honest truncation flag, substring
//      back-compat.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import { buildProjectTools } from "../src/tools/index";
import { searchCode, searchFiles } from "../src/tools/fs-ops";

// Every test gets its OWN fixture root — the gitignore rules are read from
// disk at call time, so a shared root would leak between tests.
const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acute-r96-search-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// The AI SDK tool contract — narrow to what the tests call.
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/** Deterministic fixture: two source files with known match lines. */
function seedBasicTree(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "const target = 1;\nconst other = 2;\nconst target = 3;\n", "utf8");
  writeFileSync(join(root, "src", "lib.ts"), "export const target = 9;\n", "utf8");
}

/* ── A: search_code ─────────────────────────────────────────────────────── */

describe("R96-C A: search_code output_mode — the three modes", () => {
  it("content (default): file:line: text rows grouped per file + the totals line", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "target");
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    // Totals first: 3 matches in 2 files.
    expect(lines[0]).toBe("3 matches in 2 files for 'target'");
    // file:line: text rows (grouped: all of app.ts before lib.ts).
    expect(result.output).toContain("src/app.ts:1: const target = 1;");
    expect(result.output).toContain("src/app.ts:3: const target = 3;");
    expect(result.output).toContain("src/lib.ts:1: export const target = 9;");
    // No per-file truncation noise on a fully-shown result set.
    expect(result.output).not.toContain("more matches in this file");
    expect(result.output).not.toContain("(truncated");
  });

  it("files_with_matches: one line per file WITH match counts (cheap targeting)", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "target", undefined, { outputMode: "files_with_matches" });
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("3 matches in 2 files for 'target'");
    expect(lines).toContain("src/app.ts (2 matches)");
    expect(lines).toContain("src/lib.ts (1 match)");
    // No content rows in this mode.
    expect(result.output).not.toMatch(/app\.ts:\d+:/);
  });

  it("count: per-file totals only", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "target", undefined, { outputMode: "count" });
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("3 matches in 2 files for 'target'");
    expect(lines).toContain("src/app.ts: 2");
    expect(lines).toContain("src/lib.ts: 1");
  });

  it("no matches stays the honest empty result", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "zzz-nothing");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("no content matches for 'zzz-nothing'");
  });
});

describe("R96-C A: search_code context lines (targeting without re-reading)", () => {
  it("context: N renders N lines before/after each match; matches use ':' and context uses '-'", () => {
    const root = newRoot();
    writeFileSync(
      join(root, "ctx.ts"),
      ["alpha", "beta", "const target = 1;", "gamma", "delta", "omega", "const target = 2;", "epsilon"].join("\n") + "\n",
      "utf8",
    );
    const result = searchCode(root, "target", undefined, { context: 1 });
    expect(result.ok).toBe(true);
    // Match lines: `file:N: text`.
    expect(result.output).toContain("ctx.ts:3: const target = 1;");
    expect(result.output).toContain("ctx.ts:7: const target = 2;");
    // Context lines: `file-N- text` (ripgrep -C convention).
    expect(result.output).toContain("ctx.ts-2- beta");
    expect(result.output).toContain("ctx.ts-4- gamma");
    expect(result.output).toContain("ctx.ts-6- omega");
    // The two match groups leave a GAP (spans [2,4] and [6,8] — line 5 is
    // not shown) → separated by a `--` divider.
    expect(result.output.split("\n")).toContain("--");
    expect(result.output).not.toContain("ctx.ts-5-");
  });

  it("adjacent matches merge into ONE span (no divider inside a run)", () => {
    const root = newRoot();
    writeFileSync(
      join(root, "adj.ts"),
      ["const target = 1;", "const target = 2;", "const target = 3;", "tail"].join("\n") + "\n",
      "utf8",
    );
    const result = searchCode(root, "target", undefined, { context: 1 });
    expect(result.ok).toBe(true);
    // Lines 1-3 all shown as one merged span [1,4)… context 1 → span [1,4]
    // (line 4 = "tail" as trailing context of match 3).
    expect(result.output).toContain("adj.ts:1: const target = 1;");
    expect(result.output).toContain("adj.ts-4- tail");
    expect(result.output.split("\n")).not.toContain("--");
  });
});

describe("R96-C A: search_code regex + legacy form", () => {
  it("regex: true treats the query as a REAL pattern", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "const \\w+ = \\d+", undefined, { regex: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/app.ts:1: const target = 1;");
    expect(result.output).toContain("src/lib.ts:1: export const target = 9;");
  });

  it("the default stays a LITERAL substring (regex metacharacters do not fire)", () => {
    const root = newRoot();
    writeFileSync(join(root, "lit.txt"), "a.b\naxb\n", "utf8");
    const literal = searchCode(root, "a.b");
    expect(literal.output).toContain("lit.txt:1: a.b");
    expect(literal.output).not.toContain("lit.txt:2:");
  });

  it("the legacy '/pattern/' inline form still works", () => {
    const root = newRoot();
    seedBasicTree(root);
    const result = searchCode(root, "/target = \\d+/"); // no regex flag — legacy parse
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/app.ts:1: const target = 1;");
  });

  it("an invalid regex is an honest error carrying the engine's reason", () => {
    const root = newRoot();
    const result = searchCode(root, "([unclosed", undefined, { regex: true });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("invalid regex");
  });

  it("case_sensitive + whole_word keep their back-compat semantics", () => {
    const root = newRoot();
    writeFileSync(join(root, "case.txt"), "Target\ntarget\natarget\n", "utf8");
    expect(searchCode(root, "target").output.split("\n").length - 1).toBe(3); // rows + header... assert explicitly:
    const insensitive = searchCode(root, "target");
    expect(insensitive.output).toContain("case.txt:1: Target");
    const sensitive = searchCode(root, "target", undefined, { caseSensitive: true });
    expect(sensitive.output).not.toContain("case.txt:1: Target");
    expect(sensitive.output).toContain("case.txt:2: target");
    const whole = searchCode(root, "target", undefined, { wholeWord: true });
    expect(whole.output).toContain("case.txt:2: target");
    expect(whole.output).not.toContain("atarget");
  });
});

describe("R96-C A: search_code respects .gitignore (the smart walk)", () => {
  it("basename patterns, dir rules, '!' re-includes, node_modules always skipped", () => {
    const root = newRoot();
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, "vendor"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*.log\n!important.log\ngenerated/\nvendor\n", "utf8");
    writeFileSync(join(root, "app.ts"), "needle here\n", "utf8");
    writeFileSync(join(root, "debug.log"), "needle here\n", "utf8"); // *.log — ignored
    writeFileSync(join(root, "important.log"), "needle here\n", "utf8"); // re-included
    writeFileSync(join(root, "generated", "out.txt"), "needle here\n", "utf8"); // dir rule — ignored
    writeFileSync(join(root, "vendor", "dep.ts"), "needle here\n", "utf8"); // basename dir — pruned
    writeFileSync(join(root, "node_modules", "evil.js"), "needle here\n", "utf8"); // always skipped
    writeFileSync(join(root, "src", "trace.log"), "needle here\n", "utf8"); // *.log at depth — ignored

    const result = searchCode(root, "needle");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("app.ts:1: needle here");
    expect(result.output).toContain("important.log:1: needle here");
    expect(result.output).not.toContain("debug.log");
    expect(result.output).not.toContain("trace.log");
    expect(result.output).not.toContain("generated");
    expect(result.output).not.toContain("vendor");
    expect(result.output).not.toContain("node_modules");
    // 2 matches in 2 files — the honest totals.
    expect(result.output.split("\n")[0]).toBe("2 matches in 2 files for 'needle'");
  });

  it("a SUBDIRECTORY .gitignore stacks on the root's (per-directory rules)", () => {
    const root = newRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*.log\n", "utf8");
    writeFileSync(join(root, "src", ".gitignore"), "local-only.ts\n", "utf8");
    writeFileSync(join(root, "keep.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "root.log"), "needle\n", "utf8"); // root rule
    writeFileSync(join(root, "src", "sub.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "src", "local-only.ts"), "needle\n", "utf8"); // src rule
    const result = searchCode(root, "needle");
    expect(result.output).toContain("keep.ts:1: needle");
    expect(result.output).toContain("src/sub.ts:1: needle");
    expect(result.output).not.toContain("root.log");
    expect(result.output).not.toContain("local-only.ts");
  });

  it("a search scoped to a SUBDIR still honors the ROOT's .gitignore (the chain)", () => {
    const root = newRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*.log\n", "utf8");
    writeFileSync(join(root, "src", "keep.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "src", "drop.log"), "needle\n", "utf8");
    const result = searchCode(root, "needle", "src");
    expect(result.output).toContain("src/keep.ts:1: needle");
    expect(result.output).not.toContain("drop.log");
  });

  it("binary files (a NUL byte in the first 8KB) are skipped", () => {
    const root = newRoot();
    writeFileSync(join(root, "text.txt"), "needle\n", "utf8");
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from("needle\x00more\x00binary\x00", "utf8")]), "utf8");
    const result = searchCode(root, "needle");
    expect(result.output).toContain("text.txt:1: needle");
    expect(result.output).not.toContain("blob.bin");
  });
});

describe("R96-C A: search_code per-file grouping + truncation flags", () => {
  it("a file with many matches shows the per-file cap note + the truncated flag", () => {
    const root = newRoot();
    const content = Array.from({ length: 25 }, (_, i) => `needle ${i}`).join("\n") + "\n";
    writeFileSync(join(root, "many.txt"), content, "utf8");
    const result = searchCode(root, "needle");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("…5 more matches in this file");
    expect(result.output).toContain("25 matches in 1 file for 'needle'");
    expect(result.output).toContain("(truncated");
    // The shown rows are the FIRST 20 (line numbers 1-20).
    expect(result.output).toContain("many.txt:1: needle 0");
    expect(result.output).toContain("many.txt:20: needle 19");
    expect(result.output).not.toContain("many.txt:21:");
  });

  it("max_results cuts ACROSS files with honest totals (counted, not shown)", () => {
    const root = newRoot();
    seedBasicTree(root); // app.ts has 2, lib.ts has 1
    const result = searchCode(root, "target", undefined, { maxResults: 2 });
    expect(result.ok).toBe(true);
    // Totals still tell the truth — ALL matched files are counted even past
    // the display budget…
    expect(result.output.split("\n")[0]).toContain("3 matches in 2 files for 'target'");
    // …but only 2 rows are shown (the budget) + the truncation note.
    expect(result.output).toContain("(truncated");
    const rows = result.output.split("\n").filter((l) => /:\d+: /.test(l));
    expect(rows).toHaveLength(2);
  });

  it("file_glob: no-slash patterns match basenames anywhere; slashed patterns match paths", () => {
    const root = newRoot();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "src", "deep", "c.ts"), "needle\n", "utf8");
    writeFileSync(join(root, "d.md"), "needle\n", "utf8");
    // '*.ts' → basename at ANY depth (the historical behavior).
    const basename = searchCode(root, "needle", undefined, { fileGlob: "*.ts" });
    expect(basename.output).toContain("a.ts:1:");
    expect(basename.output).toContain("src/b.ts:1:");
    expect(basename.output).toContain("src/deep/c.ts:1:");
    expect(basename.output).not.toContain("d.md");
    // 'src/*.ts' → direct children of src only.
    const path = searchCode(root, "needle", undefined, { fileGlob: "src/*.ts" });
    expect(path.output).toContain("src/b.ts:1:");
    expect(path.output).not.toContain("a.ts");
    expect(path.output).not.toContain("deep/c.ts");
    // '**/*.ts' → every .ts at any depth.
    const deep = searchCode(root, "needle", undefined, { fileGlob: "**/*.ts" });
    expect(deep.output).toContain("src/deep/c.ts:1:");
  });
});

describe("R96-C A: search_code through the real toolset", () => {
  it("the params plumb through: output_mode / context / regex / the description contract", async () => {
    const root = newRoot();
    seedBasicTree(root);
    const tools = await buildProjectTools(root);
    const code = tool(tools, "search_code");
    const desc = code.description;
    expect(desc).toContain("output_mode");
    expect(desc).toContain("files_with_matches");
    expect(desc).toContain("context");
    expect(desc).toContain("regex");
    expect(desc).toContain("gitignore");

    const byFile = await code.execute({ query: "target", output_mode: "files_with_matches" });
    expect(byFile.ok).toBe(true);
    expect(byFile.output).toContain("src/app.ts (2 matches)");
    const withContext = await code.execute({ query: "target", context: 1 });
    expect(withContext.output).toContain("src/app.ts-2- const other = 2;");
    const re = await code.execute({ query: "target = \\d+", regex: true });
    expect(re.ok).toBe(true);
    expect(re.output).toContain("src/app.ts:1: const target = 1;");
  });
});

/* ── B: search_files ────────────────────────────────────────────────────── */

describe("R96-C B: search_files glob patterns", () => {
  it("pattern '**/*.ts' matches .ts files at any depth (and only those)", () => {
    const root = newRoot();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "root.ts"), "", "utf8");
    writeFileSync(join(root, "src", "a.ts"), "", "utf8");
    writeFileSync(join(root, "src", "deep", "b.ts"), "", "utf8");
    writeFileSync(join(root, "note.md"), "", "utf8");
    const result = searchFiles(root, "", undefined, { pattern: "**/*.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("root.ts");
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("src/deep/b.ts");
    expect(result.output).not.toContain("note.md");
  });

  it("pattern 'src/*.ts' matches only DIRECT children; the '?' wildcard stays in one segment", () => {
    const root = newRoot();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "", "utf8");
    writeFileSync(join(root, "src", "deep", "b.ts"), "", "utf8");
    writeFileSync(join(root, "other", "c.ts"), "", "utf8");
    const direct = searchFiles(root, "", undefined, { pattern: "src/*.ts" });
    expect(direct.output).toContain("src/a.ts");
    expect(direct.output).not.toContain("deep/b.ts");
    expect(direct.output).not.toContain("other/c.ts");
    const question = searchFiles(root, "", undefined, { pattern: "src/?.ts" });
    expect(question.output).toContain("src/a.ts");
  });

  it("query + pattern together → honest either-or error; neither → honest empty-query error", () => {
    const root = newRoot();
    const both = searchFiles(root, "a", undefined, { pattern: "**/*.ts" });
    expect(both.ok).toBe(false);
    expect(both.output).toContain("EITHER");
    const neither = searchFiles(root, "  ");
    expect(neither.ok).toBe(false);
    expect(neither.output).toContain("non-empty");
  });
});

describe("R96-C B: search_files mtime ordering + the cap", () => {
  it("results are sorted NEWEST FIRST", () => {
    const root = newRoot();
    const t0 = new Date("2026-01-01T00:00:00Z");
    writeFileSync(join(root, "old.ts"), "", "utf8");
    writeFileSync(join(root, "mid.ts"), "", "utf8");
    writeFileSync(join(root, "new.ts"), "", "utf8");
    utimesSync(join(root, "old.ts"), t0, t0);
    utimesSync(join(root, "mid.ts"), t0, new Date(t0.getTime() + 60_000));
    utimesSync(join(root, "new.ts"), t0, new Date(t0.getTime() + 120_000));
    const result = searchFiles(root, "", undefined, { pattern: "**/*.ts" });
    expect(result.ok).toBe(true);
    const rows = result.output.split("\n").filter((l) => l.endsWith(".ts"));
    expect(rows).toEqual(["new.ts", "mid.ts", "old.ts"]);
  });

  it("the 100-file cap truncates HONESTLY (totals + the not-shown note)", () => {
    const root = newRoot();
    mkdirSync(join(root, "many"), { recursive: true });
    for (let i = 0; i < 105; i++) writeFileSync(join(root, "many", `f${String(i).padStart(3, "0")}.ts`), "", "utf8");
    const result = searchFiles(root, "", undefined, { pattern: "**/*.ts" });
    expect(result.ok).toBe(true);
    expect(result.output.split("\n")[0]).toContain("105 files matching pattern '**/*.ts'");
    expect(result.output).toContain("showing 100 of 105");
    expect(result.output).toContain("…5 more not shown");
    // Exactly 100 path rows are present.
    const rows = result.output.split("\n").filter((l) => l.startsWith("many/"));
    expect(rows).toHaveLength(100);
  });

  it("substring back-compat: case-insensitive paths, ignore rules, honest no-match", () => {
    const root = newRoot();
    mkdirSync(join(root, "src", "auth"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "src", "auth", "Login.ts"), "x", "utf8");
    writeFileSync(join(root, "src", "loginHelpers.ts"), "x", "utf8");
    writeFileSync(join(root, "node_modules", "login-evil.js"), "x", "utf8");
    const hits = searchFiles(root, "login");
    expect(hits.ok).toBe(true);
    expect(hits.output).toContain("src/auth/Login.ts");
    expect(hits.output).toContain("src/loginHelpers.ts");
    expect(hits.output).not.toContain("node_modules");
    expect(searchFiles(root, "zzz-nothing").output).toContain("no paths matching");
  });

  it("gitignore applies to name search too (the same smart walk)", () => {
    const root = newRoot();
    writeFileSync(join(root, ".gitignore"), "skip.me\n", "utf8");
    writeFileSync(join(root, "keep.ts"), "", "utf8");
    writeFileSync(join(root, "skip.me"), "", "utf8");
    const result = searchFiles(root, "", undefined, { pattern: "*" });
    expect(result.output).toContain("keep.ts");
    expect(result.output).not.toContain("skip.me");
    expect(result.output).not.toContain(".gitignore");
  });

  it("the tool plumbs the pattern param and the description teaches the glob", async () => {
    const root = newRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "only.ts"), "", "utf8");
    const tools = await buildProjectTools(root);
    const finder = tool(tools, "search_files");
    expect(finder.description).toContain("newest first");
    expect(finder.description).toContain("pattern");
    const result = await finder.execute({ pattern: "**/*.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/only.ts");
  });
});
