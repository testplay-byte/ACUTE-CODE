// @vitest-environment node
//
// ROUND-127 (R127-W6): AGENT-SMARTER — the owner's complaints, verbatim:
//   "it was not running multiple steps and commands in a single time… like
//    one command at a time, one file write at a time, while I clearly
//    mentioned… we can have multi-round steps for our agent"
//   "there was one file, and it took three tries to read the whole file…
//    the file was only 554 lines, and was only about roughly 10,000 tokens"
//   "the context of our agent is most definitely not handled well… It
//    should not be needing to reread the files again and again"
//   "while editing the files, it should properly edit the files in smarter
//    ways… it would run into issues that it failed"
// Pins (one file for the whole round):
//   A. THE WHOLE-FILE BUDGET RAISE (fs-ops READ_WHOLE_BUDGET_BYTES 48KB →
//      128KB): a ~100KB file (and a ~60KB file that rode the OLD 48KB
//      boundary) returns WHOLE in ONE call, no truncation marker; a file
//      OVER 128KB still pages with the honest marker + the EXACT next call.
//   B. THE REDUNDANT-READ REMINDER (plugins/filesystem.ts): fires on ANY
//      re-read of a SMALL file the session already read (R98's >48KB size
//      gate retired) — once per file per session; the text carries the
//      context-honesty guidance (already in context — anchor against it).
//   C. THE DESCRIPTION: read_file's tool description carries the ~128KB
//      whole-file-first language; edit_file's carries the recovery recipe.
//   D. THE PROMPTS: the AGENTIC LOOP's EXPLORE phase gains the N-files
//      arithmetic + the dependent-set conditions rule; BATCH DISCIPLINE's
//      first bullet gains the same two; the TOOL USE descriptions block's
//      read_file line gains the ~128KB whole-file clause.
//   E. THE EDIT RECOVERY UX (fs-ops): the not-found failure carries the
//      recovery recipe (may-have-changed + re-read JUST the region + the
//      128KB whole-file hint) + the truncated anchor echo (~80 chars).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import { editFile, readFileWindow } from "../src/tools/fs-ops";
import { resetFileLedgerForTest } from "../src/tools/file-ledger";
import { buildProjectSystemPrompt } from "../src/agents/prompts";

let tempDir = "";
let db: SqliteDatabase | undefined;

// The AI SDK tool contract — narrow to what the tests call.
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/** A file of ~`kb` KB made of 99-byte lines (deterministic line math). */
function fileOfLines(rel: string, lineCount: number): string {
  const line = "x".repeat(98); // 99 bytes with the newline
  const content = Array.from({ length: lineCount }, (_, i) => `L${i + 1}-${line}`).join("\n") + "\n";
  writeFileSync(join(tempDir, rel), content, "utf8");
  return content;
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r127-smarter-"));
  resetFileLedgerForTest();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── A: the whole-file budget raise ─────────────────────────────────────── */

describe("R127-W6 A: READ_WHOLE_BUDGET_BYTES 48KB → 128KB (whole-file-first)", () => {
  it("a ~60KB file — over the OLD 48KB boundary — now returns WHOLE in one call", () => {
    // The owner's class exactly: a few-hundred-line source file that USED
    // to page at 48KB rides comfortably under the raised budget.
    const content = fileOfLines("sixty.txt", Math.ceil(60 * 1024 / 99)); // ~60KB
    const result = readFileWindow(tempDir, "sixty.txt");
    expect(result.ok).toBe(true);
    const totalLines = content.split("\n").length - 1;
    // The ENTIRE file, first line to last — ONE call, no marker, no paging.
    expect(result.output.split("\n")[0]).toBe("     1  L1-" + "x".repeat(98));
    expect(result.output.endsWith(`${String(totalLines).padStart(6)}  L${totalLines}-` + "x".repeat(98))).toBe(true);
    expect(result.output).not.toContain("truncated");
    expect(result.output).not.toContain("use offset=");
  });

  it("a ~100KB file returns WHOLE in one call (the owner's 554-line/~10K-token file class with huge headroom)", () => {
    const content = fileOfLines("hundred.txt", Math.ceil(100 * 1024 / 99)); // ~100KB
    const result = readFileWindow(tempDir, "hundred.txt");
    expect(result.ok).toBe(true);
    const totalLines = content.split("\n").length - 1;
    expect(result.output.endsWith(`${String(totalLines).padStart(6)}  L${totalLines}-` + "x".repeat(98))).toBe(true);
    expect(result.output).not.toContain("truncated");
    expect(result.output).not.toContain("use offset=");
  });

  it("a file OVER 128KB still pages: PAGE 1 + the honest marker with the EXACT continuation (the promise is real)", () => {
    // ~132KB — ~4KB over the 128KB budget.
    const content = fileOfLines("over.txt", Math.ceil(132 * 1024 / 99));
    const totalLines = content.split("\n").length - 1;
    const result = readFileWindow(tempDir, "over.txt");
    expect(result.ok).toBe(true);
    const marker = result.output.match(
      /…\[file truncated: showing lines 1-(\d+) of (\d+) total \((\d+) bytes omitted after line \d+\) — use offset=(\d+) to continue\]…/,
    );
    expect(marker).not.toBeNull();
    const [, lastPageLine, total, , continueFrom] = marker!.map(Number);
    expect(total).toBe(totalLines);
    expect(continueFrom).toBe(lastPageLine + 1);
    // The tail is NOT included (page semantics — the model pages forward).
    expect(result.output).not.toContain(`L${totalLines}-`);
    // The marker's promise is REAL: the promised offset returns exactly
    // that line.
    const next = readFileWindow(tempDir, "over.txt", { offset: continueFrom, limit: 1 });
    expect(next.ok).toBe(true);
    expect(next.output).toBe(`${String(continueFrom).padStart(6)}  L${continueFrom}-` + "x".repeat(98));
  });
});

/* ── B: the redundant-read reminder on SMALL files ──────────────────────── */

describe("R127-W6 B: the redundant-read reminder fires on ANY re-read (the size gate retired)", () => {
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "",
    agentId: "r127-w6-agent",
  } as ToolDeps;

  beforeEach(async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R127-W6 Agent", providerId: "openrouter", model: "test/r127-w6" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
    resetFileLedgerForTest();
  });

  it("a re-read of a SMALL file carries the reminder — ONCE, not twice (the session-once law)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    writeFileSync(join(tempDir, "tiny.txt"), "alpha\nbeta\n", "utf8");
    const read = tool(tools, "read_file");
    // First read: clean — nothing redundant about it.
    const first = await read.execute({ path: "tiny.txt" });
    expect(first.ok).toBe(true);
    expect(first.output).not.toContain("you already read");
    // SECOND read of the SAME small file: the reminder fires (R98's >48KB
    // gate is gone — the owner: "It should not be needing to reread the
    // files again and again").
    const second = await read.execute({ path: "tiny.txt" });
    expect(second.ok).toBe(true);
    expect(second.output).toContain("--- [you already read tiny.txt this session]");
    expect(second.output).toContain("it is already in your context from that earlier read/write");
    expect(second.output).toContain("anchor edits against what you already have");
    expect(second.output).toContain("re-read only after an edit_file failure");
    // THIRD read: once per file per session — clean again.
    const third = await read.execute({ path: "tiny.txt" });
    expect(third.ok).toBe(true);
    expect(third.output).not.toContain("you already read");
  });

  it("a re-read of a ~100KB file (whole under the new budget) carries the reminder too", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    fileOfLines("big-now.txt", Math.ceil(100 * 1024 / 99));
    const read = tool(tools, "read_file");
    await read.execute({ path: "big-now.txt" });
    const second = await read.execute({ path: "big-now.txt" });
    expect(second.ok).toBe(true);
    expect(second.output).toContain("--- [you already read big-now.txt this session]");
  });

  it("sessionless builds never remind (no ledger, no noise for bare/test contexts)", async () => {
    const tools = await buildProjectTools(tempDir);
    writeFileSync(join(tempDir, "bare.txt"), "x\n", "utf8");
    const read = tool(tools, "read_file");
    await read.execute({ path: "bare.txt" });
    const second = await read.execute({ path: "bare.txt" });
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("you already read");
  });
});

/* ── C: the tool descriptions ───────────────────────────────────────────── */

describe("R127-W6 C: the descriptions teach the new contracts", () => {
  it("read_file's description carries the ~128KB whole-file-first language", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "read_file").description;
    expect(desc).toContain("under ~128KB (~32K tokens)");
    expect(desc).toContain("a few-hundred-line source file ALWAYS reads whole in one call");
    expect(desc).toContain("do NOT page with offset/limit");
    expect(desc).toContain("unless a previous call's truncation marker told you to continue");
  });

  it("edit_file's description teaches the recovery recipe (re-read the region, ~128KB whole-file hint)", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "edit_file").description;
    expect(desc).toContain("a not-found failure names the recovery");
    expect(desc).toContain("re-read JUST the region");
    expect(desc).toContain("returns whole in one call under ~128KB");
    expect(desc).toContain("echoes the first line of the anchor you tried to match");
  });
});

/* ── D: the prompt strengthening ────────────────────────────────────────── */

describe("R127-W6 D: the prompts (EXPLORE arithmetic + conditions rule + BATCH DISCIPLINE + TOOL USE)", () => {
  const ctx = {
    projectName: "R127W6",
    rootPath: "/tmp/acute-r127-w6-prompt",
    toolNames: ["read_file", "write_file", "edit_file", "list_dir", "search_code", "run_command", "todo_write"],
  };

  it("the EXPLORE phase carries the N-files-one-message arithmetic", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("a file-reading task over N files is N read_file calls in ONE message");
    expect(prompt).toContain("never N messages of one call each");
  });

  it("the EXPLORE phase carries the conditions rule (dependent calls WAIT; batch the prefix, then the dependent set)", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("When later calls DEPEND on earlier results (a path you learn from a list_dir, an anchor you learn from a read), WAIT");
    expect(prompt).toContain("batch the independent prefix, then batch the dependent set once the dependency lands");
  });

  it("BATCH DISCIPLINE's first bullet carries the same two additions (and keeps the R96/R99 pins' truths)", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    const bullet = prompt.split("\n").find((l) => l.startsWith("- **Batch independent calls:**"));
    expect(bullet).toBeDefined();
    expect(bullet!).toContain("issue them all in one response");
    expect(bullet!).toContain("a file-reading task over N files is N read_file calls in ONE message, never N messages of one call each");
    expect(bullet!).toContain("a call that needs a previous result waits for it");
    expect(bullet!).toContain("batch the independent prefix, then batch the dependent set once the dependency lands");
  });

  it("the TOOL USE descriptions block's read_file line carries the ~128KB whole-file clause", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("read_file: reads a file (the session ledger tracks freshness) — returns whole files under ~128KB in one call");
    expect(prompt).toContain("a typical source file is ONE call, do not pre-split reads");
  });
});

/* ── E: the edit_file recovery UX ───────────────────────────────────────── */

describe("R127-W6 E: the edit_file not-found failure carries the recovery recipe + anchor echo", () => {
  it("fs-ops single-edit: the recipe + the echo ride the historic PREFIX", () => {
    writeFileSync(join(tempDir, "e1.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const result = editFile(tempDir, "e1.txt", "nope\nsecond line of the anchor", "x");
    expect(result.ok).toBe(false);
    expect(result.output.startsWith("edit failed: oldString not found in 'e1.txt'")).toBe(true);
    // The recipe: likeliest cause + the concrete next call + the whole-file
    // hint (the raised budget) + re-anchor.
    expect(result.output).toContain("the file may have changed since your last read");
    expect(result.output).toContain("re-read JUST the region (read_file with offset/limit around where you expected it, or the whole file — files under 128KB return whole in one call)");
    expect(result.output).toContain("re-anchor on CURRENT content");
    // The echo: the FIRST LINE of the anchor, quoted.
    expect(result.output).toContain('you tried to match: "nope"');
  });

  it("the echo truncates at ~80 chars with an honest ellipsis (a diagnosable miss, not a wall)", () => {
    writeFileSync(join(tempDir, "e2.txt"), "alpha\n", "utf8");
    const longAnchor = "z".repeat(120);
    const result = editFile(tempDir, "e2.txt", longAnchor, "x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`you tried to match: "${"z".repeat(80)}…"`);
    expect(result.output).not.toContain("z".repeat(81));
  });

  it("through the real toolset (the r71 harness): the recipe rides the 1st failure, the streak suffix still appends after it", async () => {
    const sessionDeps = {
      db: null as unknown as ToolDeps["db"],
      sessionId: "",
      agentId: "r127-w6-edit-agent",
    } as ToolDeps;
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R127-W6 Edit Agent", providerId: "openrouter", model: "test/r127-w6e" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
    writeFileSync(join(tempDir, "e3.txt"), "alpha\nbeta\n", "utf8");

    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    const first = await edit.execute({ path: "e3.txt", oldString: "nope", newString: "x" });
    expect(first.ok).toBe(false);
    expect(first.output).toContain("edit failed: oldString not found in 'e3.txt'");
    expect(first.output).toContain("re-read JUST the region");
    expect(first.output).toContain('you tried to match: "nope"');
    // The R71 streak still keys on the prefix and still escalates on the
    // 2nd failure (the recipe did not break the machinery).
    const second = await edit.execute({ path: "e3.txt", oldString: "nope", newString: "x" });
    expect(second.output).toContain("(2nd consecutive edit failure");
    // The batch form carries the SAME recipe (notFoundRecipe is shared).
    const batch = await edit.execute({
      path: "e3.txt",
      edits: [
        { oldString: "alpha", newString: "ALPHA" },
        { oldString: "missing", newString: "X" },
      ],
    });
    expect(batch.ok).toBe(false);
    expect(batch.output).toContain("edits[1]");
    expect(batch.output).toContain("oldString not found in 'e3.txt'");
    expect(batch.output).toContain("the file may have changed since your last read");
    expect(batch.output).toContain('you tried to match: "missing"');
    expect(batch.output).toContain("NO changes were applied");
  });
});
