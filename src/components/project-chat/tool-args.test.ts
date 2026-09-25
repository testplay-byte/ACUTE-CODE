// @vitest-environment happy-dom
/**
 * ROUND-117 (R117-f) tests — the per-tool arg humanizer (tool-args.ts):
 * the pure formatters that clean a collapsed tool row's glance (path pill
 * target / command headline / delegate role·task_id) plus the failed row's
 * one-line error excerpt. The RAW argsSummary always stays the fallback.
 *
 * ROUND-128 (R128-W5) additions: splitShellCommands (the quote-aware
 * top-level splitter — && / ; / newlines, quotes protect) and
 * formatToolTarget's batch-command glance ("first · N commands").
 */
import { describe, expect, it } from "vitest";
import {
  formatToolTarget,
  splitShellCommands,
  toolCommandList,
  toolErrorExcerpt,
} from "./tool-args";

describe("splitShellCommands (R128-W5 — the quote-aware top-level splitter)", () => {
  it("splits on && / ; / newlines outside quotes, dropping blank segments", () => {
    expect(splitShellCommands("pnpm install && pnpm build")).toEqual(["pnpm install", "pnpm build"]);
    expect(splitShellCommands("cd src; pnpm test")).toEqual(["cd src", "pnpm test"]);
    expect(splitShellCommands("git add .\ngit commit -m 'x'\ngit push")).toEqual([
      "git add .",
      "git commit -m 'x'",
      "git push",
    ]);
    // Mixed chaining, in order.
    expect(splitShellCommands("a && b; c\nd")).toEqual(["a", "b", "c", "d"]);
    // Blank segments never become commands.
    expect(splitShellCommands("a &&  ; \n\n  b")).toEqual(["a", "b"]);
  });

  it("quoted separators are ARGUMENTS, never chains", () => {
    // Double-quoted && and ; stay inside the one command.
    expect(splitShellCommands('echo "a && b; c"')).toEqual(['echo "a && b; c"']);
    // Single-quoted ; likewise.
    expect(splitShellCommands("echo 'x;y' && echo done")).toEqual(["echo 'x;y'", "echo done"]);
    // A quote opened in one segment closes in the next (no cross-segment
    // splitting while inside) — the honest lenient reading.
    expect(splitShellCommands('echo "unclosed && still one"')).toEqual(['echo "unclosed && still one"']);
  });

  it("escapes and single-quote literals survive verbatim", () => {
    // Backslash-escaped separator: not a split point (the shell sees \;).
    expect(splitShellCommands("echo a\\;b")).toEqual(["echo a\\;b"]);
    // Backslash inside single quotes is LITERAL (bash rule) — the pair
    // stays whole and the quote still protects.
    expect(splitShellCommands("grep 'a\\;b' file ; echo done")).toEqual(["grep 'a\\;b' file", "echo done"]);
  });

  it("degenerate inputs: empty, whitespace, single command", () => {
    expect(splitShellCommands("")).toEqual([]);
    expect(splitShellCommands("   \n\t ; && ")).toEqual([]);
    expect(splitShellCommands("pnpm exec vitest run")).toEqual(["pnpm exec vitest run"]);
    // Windows CRLF: the \r trims away with the whitespace.
    expect(splitShellCommands("a\r\nb")).toEqual(["a", "b"]);
  });

  it("a single & (background) is NOT a chain point — only && splits", () => {
    expect(splitShellCommands("node server.js & echo started")).toEqual([
      "node server.js & echo started",
    ]);
  });
});

describe("toolCommandList (R128-W5 — the terminal card's command source)", () => {
  it("reads the command: segment and splits it; falls back to the bare summary", () => {
    expect(toolCommandList("command: pnpm install && pnpm build")).toEqual([
      "pnpm install",
      "pnpm build",
    ]);
    // Legacy/fixture shape: no "command:" key → the whole summary splits.
    expect(toolCommandList("pnpm test")).toEqual(["pnpm test"]);
    expect(toolCommandList("")).toEqual([]);
  });
});

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

  it("run_command → the command's first line; a CHAINED batch adds '· N commands' (R128-W5)", () => {
    expect(formatToolTarget("run_command", "command: pnpm exec vitest run")).toEqual({
      kind: "text",
      value: "pnpm exec vitest run",
    });
    // R128-W5: newline-chained scripts show the FIRST command + the honest
    // count (the whole string runs as ONE shell invocation).
    expect(formatToolTarget("run_command", "command: git add .\ngit commit -m 'x'\ngit push")).toEqual({
      kind: "text",
      value: "git add . · 3 commands",
    });
    // && / ; chains count the same way.
    expect(formatToolTarget("run_command", "command: pnpm install && pnpm build")).toEqual({
      kind: "text",
      value: "pnpm install · 2 commands",
    });
    expect(formatToolTarget("run_command", "command: cd src; pnpm test")).toEqual({
      kind: "text",
      value: "cd src · 2 commands",
    });
    // Quoted separators are NOT chains — one command, no suffix.
    expect(formatToolTarget("run_command", 'command: echo "a && b"')).toEqual({
      kind: "text",
      value: 'echo "a && b"',
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
