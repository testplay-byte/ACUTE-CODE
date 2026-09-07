// @vitest-environment node
//
// ROUND-70 (R70-a): TOOL FEEDBACK QUALITY — the SWE-agent ACI pins
// ("tool feedback quality ≈ model quality"):
//   D1. run_command's 64KB output cap keeps HEAD 32KB + TAIL 32KB with an
//       honest omitted-from-the-middle marker (build/test errors live at the
//       END of long logs — the old HEAD-only clip threw the tail away).
//   D2. read_file (the TOOL) is LINE-NUMBERED (cat -n style) with offset/
//       limit pagination; content after the prefix stays byte-exact; the RAW
//       readFile stays untouched for the REST file-viewer route.
//   D3. todo_write's description carries the Codex/Claude Code planning
//       discipline (snapshot semantics unchanged).
//   D4. Empty outputs are EXPLICIT everywhere: run_command success with zero
//       stdout, read_file on an empty file, job_status with an existing but
//       EMPTY log file (the case the old `logTail === null` check missed).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { readFile, readFileWindow } from "../src/tools/fs-ops";
import { runCommand } from "../src/tools/exec";
import { clearJobsForTest, registerJob } from "../src/lib/background-jobs";
import { buildProjectTools } from "../src/tools/index";
import type { ToolSet } from "ai";

let tempDir = "";

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r70-"));
  clearJobsForTest();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// The AI SDK tool contract — narrow to what the tests call (the shape the
// other toolset tests use).
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/* ── D1: run_command output cap = HEAD + TAIL, never head-only ─────────────── */

describe("R70-a D1: run_command keeps the TAIL of oversized output", () => {
  const HEAD = 32 * 1024;
  const TAIL = 32 * 1024;
  // "HEAD" + 70000 x's + "TAIL" = 70008 chars > the 64KB cap.
  const BIG = "HEAD" + "x".repeat(70_000) + "TAIL";
  const omitted = BIG.length - HEAD - TAIL; // 4472

  it(
    "output > 64KB resolves as first 32KB + honest middle marker + last 32KB",
    async () => {
      const result = await runCommand(
        tempDir,
        "node -e \"process.stdout.write('HEAD' + 'x'.repeat(70000) + 'TAIL')\"",
      );
      expect(result.ok).toBe(true);
      const output = result.output;
      // The head is EXACTLY the first 32768 chars…
      expect(output.startsWith(BIG.slice(0, HEAD))).toBe(true);
      // …the tail is EXACTLY the last 32768 chars (the old code lost this)…
      expect(output.endsWith(BIG.slice(BIG.length - TAIL))).toBe(true);
      // …and the middle is an honest marker, not silence.
      // R71-e2 (D1): the marker now also carries the recovery guidance
      // (tail included + redirect-to-file for the omitted middle) — the
      // ~200 extra chars are the marker line, still ONE line.
      expect(output).toContain(`…[output truncated: ${omitted} bytes omitted from the middle`);
      expect(output.match(/…\[output truncated:/g)?.length).toBe(1);
      expect(output).toContain("the tail is included");
      expect(output).toContain("re-run with output redirected to a file and read_file it in slices");
      // Total stays ~64KB + the one marker line — the cap still holds.
      expect(output.length).toBeLessThan(HEAD + TAIL + 400);
      // The marker sits BETWEEN the head and the tail.
      const markerAt = output.indexOf("…[output truncated:");
      expect(markerAt).toBeGreaterThan(HEAD - 100);
      expect(markerAt).toBeLessThan(HEAD + 200);
    },
    15_000,
  );

  it(
    "output at/below the cap passes through untouched (no marker, no split)",
    async () => {
      const result = await runCommand(tempDir, "node -e \"console.log('r70-small')\"");
      expect(result.ok).toBe(true);
      expect(result.output).toBe("r70-small");
    },
  );
});

/* ── D4: empty outputs are explicit, never blank ───────────────────────────── */

describe("R70-a D4: run_command empty-output honesty", () => {
  it(
    "a successful command that prints nothing says so (SWE-agent rule)",
    async () => {
      const result = await runCommand(tempDir, "node -e 0");
      expect(result.ok).toBe(true);
      expect(result.output).toBe("(no output — the command ran successfully and printed nothing)");
    },
    15_000,
  );

  it(
    "a FAILING command that prints nothing keeps the (no output) + exit-code shape",
    async () => {
      const result = await runCommand(tempDir, "node -e \"process.exit(3)\"");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("(no output)");
      expect(result.output).toContain("[exit code: 3]");
      expect(result.output).not.toContain("ran successfully");
    },
    15_000,
  );
});

describe("R70-a D4: job_status empty-output honesty", () => {
  it("a job whose log file exists but is EMPTY says 'no output captured yet' (the logTail === \"\" case the old null-check missed)", async () => {
    // An empty log file: tailFile() returns "" (not null) — the OLD code's
    // `status.logTail === null` guard skipped the no-output note entirely,
    // showing neither output nor explanation.
    writeFileSync(join(tempDir, "empty.log"), "");
    const job = registerJob({
      command: "node server.js > empty.log 2>&1",
      cwd: tempDir,
      logFile: "empty.log",
    });
    const tools = await buildProjectTools(tempDir);
    const result = await tool(tools, "job_status").execute({ job: job.id });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("log file: empty.log");
    expect(result.output).toContain("(no output captured yet");
    // No phantom "recent output:" / "log tail:" sections for empty output.
    expect(result.output).not.toContain("recent output:");
    expect(result.output).not.toContain("log tail (");
  });
});

/* ── D2: read_file line numbers + offset/limit pagination ──────────────────── */

describe("R70-a D2: readFileWindow — line numbers + pagination", () => {
  it("numbers every line cat -n style (6-width right-aligned + two spaces), content byte-exact, trailing newline is not a phantom line", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const result = readFileWindow(tempDir, "a.ts");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("     1  const a = 1;\n     2  const b = 2;");
    // No trailing newline is added to the tool output either.
    expect(result.output.endsWith("\n")).toBe(false);
  });

  it("a file with NO trailing newline gets the same treatment; a lone newline is one empty line", () => {
    writeFileSync(join(tempDir, "no-nl.txt"), "x\ny", "utf8");
    expect(readFileWindow(tempDir, "no-nl.txt").output).toBe("     1  x\n     2  y");
    writeFileSync(join(tempDir, "one-nl.txt"), "\n", "utf8");
    expect(readFileWindow(tempDir, "one-nl.txt").output).toBe("     1  ");
  });

  it("empty file → explicit 'File exists but is empty' (ok: true, never a blank result)", () => {
    writeFileSync(join(tempDir, "empty.txt"), "", "utf8");
    const result = readFileWindow(tempDir, "empty.txt");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("File exists but is empty (0 bytes): 'empty.txt'");
  });

  it("offset/limit window the file with TRUE line numbers (1-based, absolute)", () => {
    const lines = ["one", "two", "three", "four", "five"];
    writeFileSync(join(tempDir, "five.txt"), lines.join("\n") + "\n", "utf8");
    expect(readFileWindow(tempDir, "five.txt", { offset: 2, limit: 2 }).output).toBe(
      "     2  two\n     3  three",
    );
    // offset without limit = from there to EOF.
    expect(readFileWindow(tempDir, "five.txt", { offset: 4 }).output).toBe(
      "     4  four\n     5  five",
    );
  });

  it("a limit that runs past EOF says so honestly instead of looking truncated", () => {
    writeFileSync(join(tempDir, "five.txt"), ["one", "two", "three", "four", "five"].join("\n") + "\n", "utf8");
    const result = readFileWindow(tempDir, "five.txt", { offset: 4, limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("     4  four\n     5  five");
    expect(result.output).toContain("[end of file: returned lines 4-5 of 5]");
  });

  it("offset/limit validate honestly: < 1, non-integer, and past-EOF all error explicitly", () => {
    writeFileSync(join(tempDir, "five.txt"), ["one", "two", "three", "four", "five"].join("\n") + "\n", "utf8");
    const zero = readFileWindow(tempDir, "five.txt", { offset: 0 });
    expect(zero.ok).toBe(false);
    expect(zero.output).toContain("'offset' must be an integer");
    const frac = readFileWindow(tempDir, "five.txt", { offset: 1.5 });
    expect(frac.ok).toBe(false);
    expect(frac.output).toContain("'offset' must be an integer");
    const badLimit = readFileWindow(tempDir, "five.txt", { limit: 0 });
    expect(badLimit.ok).toBe(false);
    expect(badLimit.output).toContain("'limit' must be an integer");
    const past = readFileWindow(tempDir, "five.txt", { offset: 99 });
    expect(past.ok).toBe(false);
    expect(past.output).toBe("offset 99 is beyond end of file ('five.txt' has 5 lines)");
  });

  it("oversized window (> 256KB content) keeps head ~32KB + tail ~32KB with an honest marker that points at offset/limit", () => {
    // 3000 lines × 103 bytes ≈ 309KB — over the 256KB cap.
    const mk = (i: number): string => `L${i}-` + "z".repeat(96);
    const content = Array.from({ length: 3000 }, (_, i) => mk(i + 1)).join("\n") + "\n";
    writeFileSync(join(tempDir, "big.txt"), content, "utf8");

    const result = readFileWindow(tempDir, "big.txt");
    expect(result.ok).toBe(true);
    const output = result.output;
    // The head starts at line 1…
    expect(output.split("\n")[0]).toBe(`     1  ${mk(1)}`);
    // …the TAIL is the actual end of the file (the whole point of R70-a)…
    expect(output.endsWith(`  3000  ${mk(3000)}`)).toBe(true);
    // …the honest marker names the omitted middle AND (R71-e2 D1) the file's
    // total line count + the EXACT next call — kilocode's exact-continuation:
    // "use offset=N to continue" with N = the first omitted line.
    expect(output).toMatch(
      /…\[file truncated: \d+ bytes omitted between line \d+ and line \d+ of \d+ total — use offset=\d+ to continue\]…/,
    );
    // …and the middle is really gone (line 1500 is NOT in the output).
    expect(output).not.toContain("  1500  ");
    // The cap still protects the context window: ~64KB content + prefixes.
    expect(output.length).toBeGreaterThan(60_000);
    expect(output.length).toBeLessThan(90_000);

    // The marker's promise is real (R71-e2 D1: the EXACT next call in the
    // marker fetches the omitted middle) — parse the promised offset and
    // call read_file with EXACTLY it.
    const promised = output.match(/use offset=(\d+) to continue\]/);
    expect(promised).not.toBeNull();
    const continueOffset = Number(promised![1]);
    const middle = readFileWindow(tempDir, "big.txt", { offset: continueOffset, limit: 2 });
    expect(middle.ok).toBe(true);
    // The first line of the continuation is the line AFTER the kept head —
    // NOT the last head line (which the model already has).
    expect(middle.output.startsWith(`${String(continueOffset).padStart(6)}  `)).toBe(true);
    expect(middle.output).toContain("z");
    // …and the plain offset/limit fetch also still works for the middle.
    const middle2 = readFileWindow(tempDir, "big.txt", { offset: 1500, limit: 2 });
    expect(middle2.ok).toBe(true);
    expect(middle2.output).toBe(`  1500  ${mk(1500)}\n  1501  ${mk(1501)}`);
  });

  it("a single line bigger than the whole cap is byte-sliced head+tail (minified-asset shape)", () => {
    writeFileSync(join(tempDir, "one-line.txt"), "A".repeat(300_000), "utf8");
    const result = readFileWindow(tempDir, "one-line.txt");
    expect(result.ok).toBe(true);
    const output = result.output;
    // Head: prefix + first 32KB of THE line…
    expect(output.startsWith("     1  " + "A".repeat(32 * 1024))).toBe(true);
    // …tail: the last 32KB of the line, same true line number…
    expect(output.endsWith("A".repeat(32 * 1024))).toBe(true);
    // …and an honest single-line marker between them. R71-e2 (D1): it now
    // carries the total line count, the byte semantics (first/last bytes
    // kept), and says HONESTLY that no continuation call can reach the
    // middle (offset/limit pages whole LINES; this file is one line).
    expect(output).toContain("bytes omitted from the middle of line 1 of 1 total");
    expect(output).toContain("single line: first 32768 + last 32768 bytes kept");
    expect(output).toContain("no continuation call can reach this middle");
    expect(output).toContain("use search_code (content match) or run_command (grep) to inspect it");
    expect(output).toMatch(/…\[file truncated: 2\d{5} bytes omitted/);
    expect(output.length).toBeLessThan(90_000);
  });

  it("RAW readFile is unchanged (no line numbers) — the REST file-viewer route keeps byte-exact content", () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const raw = readFile(tempDir, "a.ts");
    expect(raw.ok).toBe(true);
    expect(raw.output).toBe("const a = 1;\nconst b = 2;\n");
  });
});

describe("R70-a D2: the read_file TOOL (through the real toolset)", () => {
  it("advertises line numbers + offset/limit + path:line citation in its description", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "read_file").description;
    expect(desc).toContain("line numbers");
    expect(desc).toContain("offset");
    expect(desc).toContain("limit");
    expect(desc).toContain("path:line");
    // The edit_file anchor warning (the prefix is NOT file content).
    expect(desc).toContain("The line-number prefix is NOT part of the file");
  });

  it("executes with default (whole file, numbered) and with offset/limit", async () => {
    writeFileSync(join(tempDir, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const tools = await buildProjectTools(tempDir);
    const whole = await tool(tools, "read_file").execute({ path: "a.ts" });
    expect(whole.ok).toBe(true);
    expect(whole.output).toBe("     1  const a = 1;\n     2  const b = 2;");
    const windowed = await tool(tools, "read_file").execute({ path: "a.ts", offset: 2, limit: 1 });
    expect(windowed.ok).toBe(true);
    expect(windowed.output).toBe("     2  const b = 2;");
    // A garbage (non-number) offset degrades to the default, not a crash.
    const stringOffset = await tool(tools, "read_file").execute({ path: "a.ts", offset: "2" });
    expect(stringOffset.ok).toBe(true);
    expect(stringOffset.output).toBe(whole.output);
  });
});

/* ── D3: todo_write description (semantics unchanged) ─────────────────────── */

describe("R70-a D3: todo_write planning discipline (description only)", () => {
  it("the description teaches the Codex/Claude Code guidance while keeping the snapshot semantics", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "todo_write").description;
    // Whole-list snapshot semantics preserved.
    expect(desc).toContain("snapshot, not a delta");
    expect(desc).toContain("ALL items every time");
    // The new discipline.
    expect(desc).toContain("SKIP the todo list for trivial tasks");
    expect(desc).toContain("single-item plans");
    expect(desc).toContain("in_progress BEFORE beginning it");
    expect(desc).toContain("IMMEDIATELY after completing each sub-task");
    expect(desc).toContain("progress contract");
  });

  it("the deps guard is untouched (no toolDeps → honest unavailable note)", async () => {
    const tools = await buildProjectTools(tempDir);
    const result = await tool(tools, "todo_write").execute({ todos: [] });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("todo tracking unavailable in this context");
  });
});
