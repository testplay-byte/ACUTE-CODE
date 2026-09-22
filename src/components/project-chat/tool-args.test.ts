// @vitest-environment happy-dom
/**
 * ROUND-117 (R117-f) tests — the per-tool arg humanizer (tool-args.ts):
 * the pure formatters that clean a collapsed tool row's glance (path pill
 * target / command headline / delegate role·task_id) plus the failed row's
 * one-line error excerpt. The RAW argsSummary always stays the fallback.
 */
import { describe, expect, it } from "vitest";
import { formatToolTarget, toolErrorExcerpt } from "./tool-args";

describe("formatToolTarget (the collapsed-row glance, per-tool)", () => {
  it("file tools → the path segment (summarizeArgs's 'path:' key)", () => {
    expect(formatToolTarget("read_file", "path: src/app.ts")).toEqual({
      kind: "path",
      value: "src/app.ts",
    });
    // write_file's content became "N chars" — the path still leads.
    expect(formatToolTarget("write_file", "path: src/created.ts, content: 14 chars")).toEqual({
      kind: "path",
      value: "src/created.ts",
    });
    // edit_file's oldString rides mid-summary — the boundary-aware parse
    // stops the path at the next ", key:" segment.
    expect(formatToolTarget("edit_file", "path: src/app.ts, oldString: the old text, newString: 20 chars")).toEqual({
      kind: "path",
      value: "src/app.ts",
    });
    // The git family / any path-bearing tool gets the same treatment.
    expect(formatToolTarget("git_diff", "path: src/lib/api.ts")).toEqual({
      kind: "path",
      value: "src/lib/api.ts",
    });
  });

  it("a bare list_dir ('.' / './') is NOT worth a pill — the raw string stays", () => {
    expect(formatToolTarget("list_dir", "path: .")).toBeNull();
    expect(formatToolTarget("list_dir", "path: ./")).toBeNull();
    // A real subdirectory is.
    expect(formatToolTarget("list_dir", "path: src/components")).toEqual({
      kind: "path",
      value: "src/components",
    });
  });

  it("run_command → the command's first line (multi-line scripts keep the headline only)", () => {
    expect(formatToolTarget("run_command", "command: pnpm exec vitest run")).toEqual({
      kind: "text",
      value: "pnpm exec vitest run",
    });
    expect(formatToolTarget("run_command", "command: git add .\ngit commit -m 'x'\ngit push")).toEqual({
      kind: "text",
      value: "git add .",
    });
    // Legacy/fixture shape: the bare command with no "command:" key.
    expect(formatToolTarget("run_command", "pnpm test")).toEqual({
      kind: "text",
      value: "pnpm test",
    });
  });

  it("delegate_task → the role · task_id pair (the task text stays behind the expand)", () => {
    expect(formatToolTarget("delegate_task", "task: Fix the login flow, role: coder, task_id: 4f2a")).toEqual({
      kind: "text",
      value: "coder · 4f2a",
    });
    // Pre-R117-d1 summaries carry no task_id — the role alone answers.
    expect(formatToolTarget("delegate_task", "task: Refactor auth module, role: coder")).toEqual({
      kind: "text",
      value: "coder",
    });
    // Role-less: the task_id alone still identifies the child.
    expect(formatToolTarget("delegate_task", "task: Research, task_id: bg-research")).toEqual({
      kind: "text",
      value: "bg-research",
    });
    // Neither key → the raw summary stays (it carries the task text).
    expect(formatToolTarget("delegate_task", "task: Plain task")).toBeNull();
  });

  it("unknown tools and empty summaries fall back to the raw string (null)", () => {
    expect(formatToolTarget("web_search", "query: fix the login bug")).toBeNull();
    expect(formatToolTarget("read_file", "")).toBeNull();
    expect(formatToolTarget("read_file", "offset: 100")).toBeNull();
  });
});

describe("toolErrorExcerpt (the failed row's one-line excerpt)", () => {
  it("the first non-empty line of the tool's own output", () => {
    expect(toolErrorExcerpt("ENOENT: no such file or directory, open 'src/missing.ts'")).toBe(
      "ENOENT: no such file or directory, open 'src/missing.ts'",
    );
    // Leading blank lines are skipped, not excerpted.
    expect(toolErrorExcerpt("\n\nError: something broke\ntraceback follows")).toBe(
      "Error: something broke",
    );
  });

  it("long first lines cap at 200 chars (the CSS truncate handles the visual)", () => {
    const long = "x".repeat(300);
    expect(toolErrorExcerpt(long)).toBe(`${"x".repeat(200)}…`);
  });

  it("no output at all → null (the ✗ glyph alone stays honest)", () => {
    expect(toolErrorExcerpt(undefined)).toBeNull();
    expect(toolErrorExcerpt("")).toBeNull();
    expect(toolErrorExcerpt("\n \n")).toBeNull();
  });
});
