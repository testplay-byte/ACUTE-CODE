// @vitest-environment node
//
// ROUND-96 (R96-C): TOOLS PRECISION — the owner's words this suite answers:
//   "It should be able to edit larger files easily. It should be easily able
//    to target the changes it needs to make in the files."
//   "If the user, for example, in an HTML file tells it to change a specific
//    text from this to this, then it will not try to analyze the whole HTML…
//    it will precisely target that HTML file and precisely target the text
//    which it is looking for. It will try its variants."
//   "It had an HTML file and it was reading the HTML file in parts. Even
//    though it did not need to… it could have read the whole HTML file in a
//    single go but it split the HTML file into multiple parts."
//   "It will run multiple commands in a single go. It will run batch commands
//    rather than running one command and then waiting."
// Pins:
//   A. read_file WHOLE-FILE-FIRST: under READ_WHOLE_BUDGET_BYTES the entire
//      file returns in ONE call (no marker, no paging language); just over
//      the budget → PAGE 1 + the honest marker with the total line count and
//      the EXACT next call; explicit offset/limit keep working.
//   B. edit_file: atomic edits[] batches, replaceAll counts, the ONE variant
//      rung (whitespace-normalized, honestly reported), ambiguity still
//      fails, compact confirmation, snapshots still recorded.
//   C. run_command: the description-level batching contract + timeout_ms.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { listSnapshots } from "../src/storage/snapshots";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import { READ_WHOLE_BUDGET_BYTES, editFile, editFileMulti, readFileWindow } from "../src/tools/fs-ops";

let tempDir = "";
let db: SqliteDatabase | undefined;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r96-tools-"));
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
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

/* ── A: read_file WHOLE-FILE-FIRST ──────────────────────────────────────── */

describe("R96-C A: read_file whole-file-first", () => {
  it("READ_WHOLE_BUDGET_BYTES is the named ~48KB export", () => {
    expect(READ_WHOLE_BUDGET_BYTES).toBe(48 * 1024);
  });

  it("a file under the budget returns the WHOLE file in one call — no marker, no paging language", () => {
    // A realistic modest HTML file — the owner's exact bug class.
    const html = [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "  <head><title>Invoice</title></head>",
      "  <body>",
      "    <h1>Invoice #42</h1>",
      "    <p>Total due: $120.00</p>",
      "  </body>",
      "</html>",
    ].join("\n");
    writeFileSync(join(tempDir, "invoice.html"), html, "utf8");
    const result = readFileWindow(tempDir, "invoice.html");
    expect(result.ok).toBe(true);
    // The ENTIRE file, first line to last.
    expect(result.output).toContain("     1  <!DOCTYPE html>");
    expect(result.output.endsWith("     8  </html>")).toBe(true);
    // No truncation marker, no continuation language — the model must not be
    // taught to page a file it already has in full.
    expect(result.output).not.toContain("truncated");
    expect(result.output).not.toContain("use offset=");
    expect(result.output).not.toContain("[end of file");
  });

  it("a file just OVER the budget returns PAGE 1 + the honest marker with the total line count and the EXACT next call", () => {
    // 49KB of content — 1KB over the 48KB budget.
    const line = "x".repeat(98); // 99 bytes with the newline
    const count = Math.ceil(49 * 1024 / 99); // ~507 lines
    const content = Array.from({ length: count }, (_, i) => `L${i + 1}-${line}`).join("\n") + "\n";
    writeFileSync(join(tempDir, "over.html"), content, "utf8");
    const totalLines = content.split("\n").length - 1;

    const result = readFileWindow(tempDir, "over.html");
    expect(result.ok).toBe(true);
    const output = result.output;
    // Page 1 starts at line 1…
    expect(output.split("\n")[0]).toBe(`     1  L1-${line}`);
    // …carries the honest marker: totals + the EXACT next call…
    const marker = output.match(/…\[file truncated: showing lines 1-(\d+) of (\d+) total \((\d+) bytes omitted after line \d+\) — use offset=(\d+) to continue\]…/);
    expect(marker).not.toBeNull();
    const [, lastPageLine, total, , continueFrom] = marker!.map(Number);
    expect(total).toBe(totalLines);
    // …the exact next call is the line AFTER page 1…
    expect(continueFrom).toBe(lastPageLine + 1);
    // …the tail is NOT included (page semantics, not head+tail — the model
    // pages forward from the marker)…
    expect(output).not.toContain(`L${totalLines}-${line}`);
    // …and the marker's promise is REAL: the promised offset returns exactly
    // that line.
    const next = readFileWindow(tempDir, "over.html", { offset: continueFrom, limit: 1 });
    expect(next.ok).toBe(true);
    expect(next.output).toBe(`${String(continueFrom).padStart(6)}  L${continueFrom}-${line}`);
  });

  it("explicit offset/limit still work for targeted re-reads (back-compat)", () => {
    writeFileSync(join(tempDir, "five.txt"), ["one", "two", "three", "four", "five"].join("\n") + "\n", "utf8");
    expect(readFileWindow(tempDir, "five.txt", { offset: 2, limit: 2 }).output).toBe("     2  two\n     3  three");
    expect(readFileWindow(tempDir, "five.txt", { offset: 4 }).output).toBe("     4  four\n     5  five");
  });

  it("the tool description teaches whole-file-first (and keeps the anchor + path:line discipline)", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "read_file").description;
    expect(desc).toContain("WHOLE file in one call");
    expect(desc).toContain("do NOT page small files");
    expect(desc).toContain("Only genuinely large files page");
    // The discipline that must survive the rewrite:
    expect(desc).toContain("path:line");
    expect(desc).toContain("The line-number prefix is NOT part of the file");
    expect(desc).toContain("offset");
    expect(desc).toContain("limit");
  });
});

/* ── B: edit_file — multi-edit, replaceAll, the variant rung ───────────── */

describe("R96-C B: edit_file single shape (fs-ops)", () => {
  it("exact unique anchor → applied, compact confirmation, no diff body", () => {
    writeFileSync(join(tempDir, "s1.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const result = editFile(tempDir, "s1.ts", "const b = 2;", "const b = 20;");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Edited 's1.ts': 1 replacement, +1 −1 lines");
    expect(readFileSync(join(tempDir, "s1.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\n");
  });

  it("not-found keeps the byte-exact historic diagnostic (the streak machinery keys on it)", () => {
    writeFileSync(join(tempDir, "s2.txt"), "alpha\n", "utf8");
    const result = editFile(tempDir, "s2.txt", "nope", "x");
    expect(result.ok).toBe(false);
    expect(result.output).toBe("edit failed: oldString not found in 's2.txt'");
  });

  it("ambiguity fails with the longer-anchor diagnostic + the replaceAll hint", () => {
    writeFileSync(join(tempDir, "s3.txt"), "same same\n", "utf8");
    const result = editFile(tempDir, "s3.txt", "same", "different");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("matches 2 times");
    expect(result.output).toContain("provide a longer unique anchor");
    expect(result.output).toContain("replaceAll");
  });

  it("replaceAll: true replaces EVERY occurrence and reports the count", () => {
    writeFileSync(join(tempDir, "s4.txt"), "foo bar foo baz foo\n", "utf8");
    const result = editFile(tempDir, "s4.txt", "foo", "qux", { replaceAll: true });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Edited 's4.txt': 3 replacements, +1 −1 lines");
    expect(readFileSync(join(tempDir, "s4.txt"), "utf8")).toBe("qux bar qux baz qux\n");
  });

  it("the variant rung: exact anchor misses on indentation, whitespace-normalized matches, and the result SAYS so", () => {
    // The owner: "It will try its variants." ONE rung — whitespace runs in the
    // anchor and the content compare as a single space.
    writeFileSync(join(tempDir, "s5.ts"), "function  hello( ) {\n\treturn 1;\n}\n", "utf8");
    const result = editFile(tempDir, "s5.ts", "function hello( ) {", "function goodbye() {");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 replacement");
    expect(result.output).toContain("(whitespace-normalized rung");
    expect(readFileSync(join(tempDir, "s5.ts"), "utf8")).toBe("function goodbye() {\n\treturn 1;\n}\n");
  });

  it("the rung replaces the ORIGINAL bytes' span (a collapsed run collapses in the output)", () => {
    writeFileSync(join(tempDir, "s6.ts"), "start\n\n\n\nend\n", "utf8");
    const result = editFile(tempDir, "s6.ts", "start\n\n\nend", "begin\nfinish");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("whitespace-normalized");
    expect(readFileSync(join(tempDir, "s6.ts"), "utf8")).toBe("begin\nfinish\n");
  });

  it("rung ambiguity still fails honestly (no fuzz past one rung)", () => {
    writeFileSync(join(tempDir, "s7.txt"), "a  b\na b\n", "utf8");
    // Exact "a  b" (two spaces) matches once — so this is the exact rung and
    // succeeds; the rung-ambiguity check needs the exact anchor ABSENT:
    const ok = editFile(tempDir, "s7.txt", "a  b", "c");
    expect(ok.ok).toBe(true);
    writeFileSync(join(tempDir, "s8.txt"), "x  y\nx   y\n", "utf8");
    // "x y" (single space) is absent exactly; normalized it matches twice.
    const result = editFile(tempDir, "s8.txt", "x y", "z");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("edit failed:");
    expect(result.output).toContain("matches 2 times after whitespace normalization");
    expect(result.output).toContain("provide a longer unique anchor");
  });

  it("an anchor found exactly is NEVER re-matched through the rung (exact-first doctrine)", () => {
    writeFileSync(join(tempDir, "s9.txt"), "value: 1\n", "utf8");
    const result = editFile(tempDir, "s9.txt", "value: 1", "value: 2");
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("whitespace-normalized");
  });
});

describe("R96-C B: edit_file atomic batches (editFileMulti)", () => {
  it("happy path: sequenced anchors apply IN ORDER (op 2 anchors text created by op 1), ONE write", () => {
    writeFileSync(join(tempDir, "m1.ts"), "import { a } from \"./a\";\n\nconst x = a;\n", "utf8");
    const result = editFileMulti(tempDir, "m1.ts", [
      { oldString: "import { a } from \"./a\";", newString: "import { b } from \"./b\";" },
      { oldString: "const x = a;", newString: "const x = b;" },
      { oldString: "const x = b;", newString: "const x = b + 1;" }, // anchors on op 1's RESULT
    ]);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Edited 'm1.ts': 3 replacements, +3 −3 lines");
    expect(readFileSync(join(tempDir, "m1.ts"), "utf8")).toBe(
      "import { b } from \"./b\";\n\nconst x = b + 1;\n",
    );
  });

  it("failure reports the failing INDEX + ordinal and leaves the file UNTOUCHED (byte-identical)", () => {
    const original = "one\ntwo\nthree\n";
    writeFileSync(join(tempDir, "m2.txt"), original, "utf8");
    const result = editFileMulti(tempDir, "m2.txt", [
      { oldString: "one", newString: "ONE" },
      { oldString: "missing", newString: "X" }, // fails — 2nd of 3
      { oldString: "three", newString: "THREE" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("edit failed:");
    expect(result.output).toContain("edits[1]");
    expect(result.output).toContain("(2nd of 3)");
    expect(result.output).toContain("oldString not found in 'm2.txt'");
    expect(result.output).toContain("NO changes were applied");
    expect(result.output).toContain("the file is untouched");
    expect(result.output).toContain("the other 2 edits were not applied");
    // ATOMICITY: nothing landed — not even the anchors that matched.
    expect(readFileSync(join(tempDir, "m2.txt"), "utf8")).toBe(original);
  });

  it("a rung match inside a batch is reported per index", () => {
    writeFileSync(join(tempDir, "m3.ts"), "const  one = 1;\nconst two = 2;\n", "utf8");
    const result = editFileMulti(tempDir, "m3.ts", [
      { oldString: "const one = 1;", newString: "const one = 10;" }, // rung (double space in file)
      { oldString: "const two = 2;", newString: "const two = 20;" }, // exact
    ]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 replacements");
    expect(result.output).toContain("(whitespace-normalized rung on #1)");
    expect(readFileSync(join(tempDir, "m3.ts"), "utf8")).toBe("const one = 10;\nconst two = 20;\n");
  });

  it("the 32-op cap is an honest error, not a slow mega-apply", () => {
    writeFileSync(join(tempDir, "m4.txt"), "x\n", "utf8");
    const tooMany = Array.from({ length: 33 }, () => ({ oldString: "x", newString: "y" }));
    const result = editFileMulti(tempDir, "m4.txt", tooMany);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("exceed the 32-edit cap");
    expect(result.output.startsWith("cannot edit")).toBe(true);
    expect(readFileSync(join(tempDir, "m4.txt"), "utf8")).toBe("x\n");
  });

  it("empty array / non-string members are honest shape errors", () => {
    writeFileSync(join(tempDir, "m5.txt"), "x\n", "utf8");
    expect(editFileMulti(tempDir, "m5.txt", []).ok).toBe(false);
    const bad = editFileMulti(tempDir, "m5.txt", [{ oldString: 5, newString: "y" } as unknown as { oldString: string; newString: string }]);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("edits[0]");
  });
});

describe("R96-C B: edit_file through the real toolset", () => {
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "",
    agentId: "r96-c-agent",
  } as ToolDeps;

  beforeEach(async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R96-C Agent", providerId: "openrouter", model: "test/r96-1" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
  });

  it("the single shape via the tool: replaceAll counts; shape errors are honest", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "t1.txt"), "a a a\n", "utf8");
    const single = await edit.execute({ path: "t1.txt", oldString: "a a a", newString: "b b b" });
    expect(single.ok).toBe(true);
    writeFileSync(join(tempDir, "t1.txt"), "a a a\n", "utf8");
    const all = await edit.execute({ path: "t1.txt", oldString: "a", newString: "b", replaceAll: true });
    expect(all.ok).toBe(true);
    expect(all.output).toContain("3 replacements");
    expect(readFileSync(join(tempDir, "t1.txt"), "utf8")).toBe("b b b\n");
    // Both forms at once → honest error, file untouched.
    writeFileSync(join(tempDir, "t1.txt"), "keep\n", "utf8");
    const both = await edit.execute({
      path: "t1.txt",
      oldString: "keep",
      newString: "x",
      edits: [{ oldString: "keep", newString: "y" }],
    });
    expect(both.ok).toBe(false);
    expect(both.output).toContain("not both");
    const neither = await edit.execute({ path: "t1.txt" });
    expect(neither.ok).toBe(false);
    expect(neither.output).toContain("missing oldString/newString");
    expect(readFileSync(join(tempDir, "t1.txt"), "utf8")).toBe("keep\n");
  });

  it("the batch shape via the tool: atomic, and ONE before/after snapshot lands for the whole batch", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "t2.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const result = await edit.execute({
      path: "t2.ts",
      edits: [
        { oldString: "const a = 1;", newString: "const a = 10;" },
        { oldString: "const b = 2;", newString: "const b = 20;" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 replacements");
    expect(readFileSync(join(tempDir, "t2.ts"), "utf8")).toBe("const a = 10;\nconst b = 20;\n");
    // The snapshot story: ONE row for the whole batch (whole-file before/after
    // — the UI renders diffs from it; a partial-batch row would be unauditable).
    const snaps = listSnapshots(db!, sessionDeps.sessionId).filter((s) => s.path === "t2.ts");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].beforeContent).toBe("const a = 1;\nconst b = 2;\n");
    expect(snaps[0].afterContent).toBe("const a = 10;\nconst b = 20;\n");
    expect(snaps[0].toolName).toBe("edit_file");
  });

  it("a failed batch records NO snapshot and escalates the streak like any anchor failure", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "t3.txt"), "one\n", "utf8");
    const result = await edit.execute({
      path: "t3.txt",
      edits: [
        { oldString: "one", newString: "ONE" },
        { oldString: "missing", newString: "X" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("edits[1]");
    expect(result.output).toContain("NO changes were applied");
    expect(listSnapshots(db!, sessionDeps.sessionId).filter((s) => s.path === "t3.txt")).toHaveLength(0);
    // A second failure gains the R71 escalation suffix (the batch failure
    // counts as an anchor failure).
    const second = await edit.execute({
      path: "t3.txt",
      edits: [{ oldString: "still missing", newString: "X" }],
    });
    expect(second.output).toContain("2nd consecutive edit failure");
  });

  it("the description teaches the new contract", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "edit_file").description;
    expect(desc).toContain("EXACTLY ONCE");
    expect(desc).toContain("replaceAll");
    expect(desc).toContain("whitespace-normalized");
    expect(desc).toContain("atomic write");
    expect(desc).toContain("UNTOUCHED");
    expect(desc).toContain("max 32");
  });
});

/* ── C: run_command batching + timeout_ms ───────────────────────────────── */

describe("R96-C C: run_command batching contract + timeout_ms", () => {
  it("the description teaches chaining + parallel calls + timeout_ms", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "run_command").description;
    expect(desc).toContain("BATCH related commands into ONE call");
    expect(desc).toContain("cmd1 && cmd2");
    expect(desc).toContain("parallel");
    expect(desc).toContain("timeout_ms");
  });

  it("chained commands run in ONE call (&& keeps later steps gated on earlier success)", async () => {
    const tools = await buildProjectTools(tempDir);
    const result = await tool(tools, "run_command").execute({
      command: "node -e \"console.log('step-one')\" && node -e \"console.log('step-two')\"",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("step-one");
    expect(result.output).toContain("step-two");
  });

  it("timeout_ms is validated honestly (non-integer / out of range → error, never a silent clamp)", async () => {
    const tools = await buildProjectTools(tempDir);
    const cmd = tool(tools, "run_command");
    const low = await cmd.execute({ command: "node -e 0", timeout_ms: 500 });
    expect(low.ok).toBe(false);
    expect(low.output).toContain("'timeout_ms' must be an integer between 1000 and 600000");
    const high = await cmd.execute({ command: "node -e 0", timeout_ms: 700000 });
    expect(high.ok).toBe(false);
    expect(high.output).toContain("'timeout_ms' must be an integer between 1000 and 600000");
    const frac = await cmd.execute({ command: "node -e 0", timeout_ms: 1500.5 });
    expect(frac.ok).toBe(false);
    expect(frac.output).toContain("'timeout_ms' must be an integer between 1000 and 600000");
  });

  it("timeout_ms actually bounds the command (a slow command is killed and reported as a timeout)", async () => {
    const tools = await buildProjectTools(tempDir);
    const result = await tool(tools, "run_command").execute({
      command: "node -e \"setTimeout(() => {}, 20000)\"",
      timeout_ms: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("[timeout]");
    expect(result.output).toContain("1000ms");
  }, 15_000);
});
