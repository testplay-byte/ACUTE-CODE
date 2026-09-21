// @vitest-environment node
//
// ROUND-98 (R98-F2): the SESSION FILE-FRESHNESS LEDGER — the owner's ask,
// verbatim: "It just created a file and then I tell it to change something
// in that file. It should not be the one to read the whole file again. It
// does know where things are and how it handled it. It should be able to
// directly make those changes as needed… context-optimized and
// token-optimized."
//
// Pins:
//   A. LEDGER SEMANTICS (tools/file-ledger.ts pure) — fresh/stale/unknown,
//      read-then-write stamping, the LRU cap + recency refresh, path
//      normalization, sessionless no-ops.
//   B. THE WIRING (plugins/filesystem.ts through the real toolset) — a read
//      records; an edit records; the owner's core case (edit the SAME file
//      again directly, no re-read, no warning); the stale-warning prepend on
//      success; the stale evidence on anchor FAILURE; the byte-exact old
//      error when the ledger has no entry; the bounded redundant-read
//      reminder (only >48KB re-reads, once per file per session).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import { READ_WHOLE_BUDGET_BYTES } from "../src/tools/fs-ops";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import {
  LEDGER_MAX_ENTRIES_PER_SESSION,
  ledgerCheckFresh,
  ledgerHasEntry,
  ledgerLastSeenAgeMs,
  ledgerRecordRead,
  ledgerRecordWrite,
  resetFileLedgerForTest,
  shouldRemindRedundantRead,
} from "../src/tools/file-ledger";

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

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98f2-"));
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

/** The stat shape the ledger consumes (from statSync — the wiring's source). */
function statOf(abs: string): { mtimeMs: number; size: number } {
  const s = statSync(abs);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

/* ── A: the ledger's own semantics ───────────────────────────────────────── */

describe("R98-F2 A: ledger freshness semantics", () => {
  it("unknown for a path the session never saw; fresh while the stat matches; stale when size or mtime moves", () => {
    const abs = join(tempDir, "never-seen.txt");
    writeFileSync(abs, "hello\n", "utf8");
    const stat = statOf(abs);
    // No entry yet.
    expect(ledgerCheckFresh("sess-a", abs, stat)).toBe("unknown");
    expect(ledgerHasEntry("sess-a", abs)).toBe(false);

    ledgerRecordRead("sess-a", abs, stat);
    expect(ledgerHasEntry("sess-a", abs)).toBe(true);
    expect(ledgerCheckFresh("sess-a", abs, stat)).toBe("fresh");
    // A different session knows nothing (per-SESSION state).
    expect(ledgerCheckFresh("sess-b", abs, stat)).toBe("unknown");

    // Size moved → stale (the content is no longer what the model saw).
    expect(ledgerCheckFresh("sess-a", abs, { ...stat, size: stat.size + 1 })).toBe("stale");
    // mtime moved with the SAME size → still stale (bytes were rewritten).
    expect(ledgerCheckFresh("sess-a", abs, { ...stat, mtimeMs: stat.mtimeMs + 5 })).toBe("stale");
  });

  it("recordWrite refreshes the truth: after the model authors a file, the POST-write stat is what 'fresh' means", () => {
    const abs = join(tempDir, "authored.txt");
    writeFileSync(abs, "one\n", "utf8");
    const readStat = statOf(abs);
    ledgerRecordRead("sess-w", abs, readStat);

    // The model writes (different bytes, different stat).
    writeFileSync(abs, "one\ntwo\n", "utf8");
    const writeStat = statOf(abs);
    expect(ledgerCheckFresh("sess-w", abs, writeStat)).toBe("stale"); // pre-write truth is now stale
    ledgerRecordWrite("sess-w", abs, writeStat);
    expect(ledgerCheckFresh("sess-w", abs, writeStat)).toBe("fresh"); // the authored view is current
  });

  it("ledgerLastSeenAgeMs: null without an entry; a positive age with one (the warning's '(X ms ago)')", () => {
    const abs = join(tempDir, "age.txt");
    writeFileSync(abs, "x\n", "utf8");
    expect(ledgerLastSeenAgeMs("sess-age", abs)).toBeNull();
    ledgerRecordRead("sess-age", abs, statOf(abs));
    const age = ledgerLastSeenAgeMs("sess-age", abs);
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThanOrEqual(0);
    // The last-seen stamp advances on a write.
    ledgerRecordWrite("sess-age", abs, statOf(abs));
    expect(ledgerLastSeenAgeMs("sess-age", abs)).toBeLessThan(5_000);
  });

  it("path normalization: redundant separators and dot segments are ONE key", () => {
    mkdirSync(join(tempDir, "a"), { recursive: true });
    const abs = join(tempDir, "a", "b.ts");
    writeFileSync(abs, "const b = 1;\n", "utf8");
    const stat = statOf(abs);
    ledgerRecordRead("sess-norm", `${tempDir}/a/./b.ts`, stat);
    expect(ledgerCheckFresh("sess-norm", `${tempDir}/a//b.ts`, stat)).toBe("fresh");
    expect(ledgerCheckFresh("sess-norm", abs, stat)).toBe("fresh");
    expect(ledgerHasEntry("sess-norm", join(tempDir, "a", "c.ts"))).toBe(false);
  });

  it("the LRU cap: over 200 entries the LEAST recently touched path decays to unknown; touching refreshes recency", () => {
    const first = join(tempDir, "k-000.txt");
    const second = join(tempDir, "k-001.txt");
    const stat = { mtimeMs: Date.now(), size: 1 };
    for (let i = 0; i < LEDGER_MAX_ENTRIES_PER_SESSION; i++) {
      ledgerRecordRead("sess-lru", join(tempDir, `k-${String(i).padStart(3, "0")}.txt`), stat);
    }
    expect(ledgerCheckFresh("sess-lru", first, stat)).toBe("fresh");
    // Re-touch the FIRST entry (refreshes its recency)…
    ledgerRecordRead("sess-lru", first, stat);
    // …then one MORE path pushes the map over the cap — the eviction takes
    // the now-least-recent entry (the second), NOT the touched first.
    ledgerRecordRead("sess-lru", join(tempDir, "k-plus.txt"), stat);
    expect(ledgerCheckFresh("sess-lru", first, stat)).toBe("fresh");
    expect(ledgerCheckFresh("sess-lru", second, stat)).toBe("unknown");
    // The cap holds (bounded per session — the documented trim).
    ledgerRecordRead("sess-lru", join(tempDir, "k-plus2.txt"), stat);
    expect(ledgerCheckFresh("sess-lru", join(tempDir, "k-002.txt"), stat)).toBe("unknown");
  });

  it("sessionless callers never record and always read unknown (bare/test builds stay deterministic)", () => {
    const abs = join(tempDir, "bare.txt");
    writeFileSync(abs, "x\n", "utf8");
    const stat = statOf(abs);
    ledgerRecordRead(undefined, abs, stat);
    ledgerRecordWrite(undefined, abs, stat);
    expect(ledgerCheckFresh(undefined, abs, stat)).toBe("unknown");
    expect(ledgerHasEntry(undefined, abs)).toBe(false);
    expect(shouldRemindRedundantRead(undefined, abs)).toBe(false);
  });
});

/* ── B0: the prompt rule (the FILE EDITING tiered contract) ─────────────── */

describe("R98-F2: the FILE EDITING tiered rule (the prompt re-pin)", () => {
  const ctx = {
    projectName: "R98F2",
    rootPath: "/tmp/acute-r98f2-prompt",
    toolNames: ["read_file", "write_file", "edit_file", "search_code", "index_project"],
  };

  it("rule 1 is the honest TIER: read before the FIRST edit; a successful edit IS the confirmation — edit the SAME file directly; re-read only on warning/failure/high-stakes", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("**Read before the first edit**");
    expect(prompt).toContain("the response is the confirmation — edit the same file again directly");
    // R107-a (F8): old rule 6's high-stakes risk list merged into rule 1 —
    // the tier now names all three re-read triggers in one place.
    expect(prompt).toContain("Re-read only when a tool warns the file changed on disk, an edit fails, or the change is high-stakes (complex edit, critical file)");
    // The retired absolutism is GONE (it taught a re-read before every edit).
    expect(prompt).not.toContain("ALWAYS use read_file before edit_file or write_file on an existing file");
    // And old rule 6 is gone (merged, not duplicated).
    expect(prompt).not.toContain("**Smart verification**");
  });

  it("the edit_file TOOL DESCRIPTION teaches the same tier (the schema is where the model actually looks)", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "edit_file").description;
    expect(desc).toContain("before the FIRST edit of a file this session");
    expect(desc).toContain("edit again directly without re-reading");
  });
});

/* ── B: the wiring through the real toolset ─────────────────────────────── */

describe("R98-F2 B: the ledger wiring (read_file / edit_file / write_file)", () => {
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "",
    agentId: "r98-f2-agent",
  } as ToolDeps;

  beforeEach(async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R98-F2 Agent", providerId: "openrouter", model: "test/r98-f2" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
    resetFileLedgerForTest();
  });

  it("a successful read_file RECORDS the entry (the next freshness check says fresh)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    writeFileSync(join(tempDir, "r1.txt"), "alpha\nbeta\n", "utf8");
    const read = await tool(tools, "read_file").execute({ path: "r1.txt" });
    expect(read.ok).toBe(true);
    const abs = join(tempDir, "r1.txt");
    expect(ledgerHasEntry(sessionDeps.sessionId, abs)).toBe(true);
    expect(ledgerCheckFresh(sessionDeps.sessionId, abs, statOf(abs))).toBe("fresh");
  });

  it("a successful edit_file RECORDS the post-write stat — THE OWNER'S CASE: edit the SAME file again directly, no re-read, no warning", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "owner.txt"), "const a = 1;\nconst b = 2;\n", "utf8");
    const first = await edit.execute({ path: "owner.txt", oldString: "const a = 1;", newString: "const a = 10;" });
    expect(first.ok).toBe(true);
    expect(first.output).toBe("Edited 'owner.txt': 1 replacement, +1 −1 lines");
    // The SECOND edit — directly, WITHOUT any re-read: succeeds, and the
    // output is the PLAIN confirmation (no staleness warning, no reminder —
    // silence is the token-optimization contract).
    const second = await edit.execute({ path: "owner.txt", oldString: "const b = 2;", newString: "const b = 20;" });
    expect(second.ok).toBe(true);
    expect(second.output).toBe("Edited 'owner.txt': 1 replacement, +1 −1 lines");
    expect(readFileSync(join(tempDir, "owner.txt"), "utf8")).toBe("const a = 10;\nconst b = 20;\n");
    // The ledger's post-write truth is current.
    expect(ledgerCheckFresh(sessionDeps.sessionId, join(tempDir, "owner.txt"), statOf(join(tempDir, "owner.txt")))).toBe("fresh");
  });

  it("write_file records too (the model authored the whole file)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const wrote = await tool(tools, "write_file").execute({ path: "w1.txt", content: "fresh bytes\n" });
    expect(wrote.ok).toBe(true);
    const abs = join(tempDir, "w1.txt");
    expect(ledgerCheckFresh(sessionDeps.sessionId, abs, statOf(abs))).toBe("fresh");
    // …and the follow-up edit is direct (no read-first needed).
    const edit = await tool(tools, "edit_file").execute({ path: "w1.txt", oldString: "fresh bytes", newString: "fresher bytes" });
    expect(edit.ok).toBe(true);
    expect(edit.output).not.toContain("warning");
  });

  it("a STALE edit that still matches PREPENDS the honest one-line warning (the edit still applies)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "user-touched.txt"), "keep me\nchange me\n", "utf8");
    await tool(tools, "read_file").execute({ path: "user-touched.txt" });
    // The USER (or another process) edits the file behind the model's back —
    // a different SIZE guarantees the ledger flips to stale regardless of
    // mtime resolution.
    writeFileSync(join(tempDir, "user-touched.txt"), "keep me\nchange me\nplus a new line\n", "utf8");
    const result = await edit.execute({ path: "user-touched.txt", oldString: "change me", newString: "changed" });
    expect(result.ok).toBe(true);
    // One prepended warning line, then the normal confirmation.
    const lines = result.output.split("\n");
    expect(lines[0]).toMatch(/^\[warning: the file changed on disk since you last read it \(\d+ ms ago\) — the anchor may not match; re-read if the edit fails\]$/);
    expect(lines[1]).toBe("Edited 'user-touched.txt': 1 replacement, +1 −1 lines");
    // The edit DID land (the anchor engine is the real guard).
    expect(readFileSync(join(tempDir, "user-touched.txt"), "utf8")).toContain("changed");
    // The post-edit stat re-pins the ledger: the next edit is silent again.
    const next = await edit.execute({ path: "user-touched.txt", oldString: "plus a new line", newString: "plus another" });
    expect(next.ok).toBe(true);
    expect(next.output).not.toContain("warning");
  });

  it("a STALE anchor FAILURE names the disk change + the re-read remedy (the ledger's evidence strengthens the honest error)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    const edit = tool(tools, "edit_file");
    writeFileSync(join(tempDir, "miss.txt"), "target line\n", "utf8");
    await tool(tools, "read_file").execute({ path: "miss.txt" });
    // External change that REMOVES the anchor.
    writeFileSync(join(tempDir, "miss.txt"), "totally different bytes now\n", "utf8");
    const result = await edit.execute({ path: "miss.txt", oldString: "target line", newString: "x" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("edit failed: oldString not found in 'miss.txt'");
    expect(result.output).toMatch(/— the file changed on disk since you last read it \(\d+ ms ago\): re-read it with read_file and re-anchor on the CURRENT content/);
  });

  it("an anchor failure WITHOUT a ledger entry keeps the byte-exact historic error (no fabricated staleness)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    writeFileSync(join(tempDir, "cold.txt"), "one\n", "utf8");
    // No read_file first — the ledger has no entry, so no evidence is added.
    const result = await tool(tools, "edit_file").execute({ path: "cold.txt", oldString: "nope", newString: "x" });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("edit failed: oldString not found in 'cold.txt'");
  });
});

describe("R98-F2 B: the bounded redundant-read reminder", () => {
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "",
    agentId: "r98-f2b-agent",
  } as ToolDeps;

  beforeEach(async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R98-F2B Agent", providerId: "openrouter", model: "test/r98-f2b" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
    resetFileLedgerForTest();
  });

  /** A file OVER the ~48KB whole-file budget (the expensive re-read class). */
  function bigFile(rel: string): void {
    const line = "y".repeat(99); // 100 bytes with the newline
    const content = Array.from({ length: 600 }, (_, i) => `B${i}-${line}`).join("\n") + "\n"; // ~60KB
    writeFileSync(join(tempDir, rel), content, "utf8");
  }

  it("the FIRST read of a big file carries NO reminder (nothing redundant about it)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    bigFile("big-first.txt");
    const first = await tool(tools, "read_file").execute({ path: "big-first.txt" });
    expect(first.ok).toBe(true);
    expect(first.output).not.toContain("you already read");
  });

  it("a RE-READ of a >48KB file carries the ONE-LINE reminder — once per file per session", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    bigFile("big.txt");
    const read = tool(tools, "read_file");
    await read.execute({ path: "big.txt" });
    const second = await read.execute({ path: "big.txt" });
    expect(second.ok).toBe(true);
    // The R73-d fenced note, riding the read's tail.
    expect(second.output).toContain("--- [you already read big.txt this session]");
    expect(second.output).toContain("you already read big.txt this session — prefer direct edits with anchors from your last read/write.");
    expect(second.output).toContain("(end note — the surrounding content is unaffected)");
    // THIRD read: the reminder already fired for this file — clean output.
    const third = await read.execute({ path: "big.txt" });
    expect(third.ok).toBe(true);
    expect(third.output).not.toContain("you already read");
  });

  it("a re-read of a SMALL file (≤48KB) stays unreminded — the threshold is the documented expense line", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    writeFileSync(join(tempDir, "small.txt"), "tiny\n", "utf8");
    expect(statSync(join(tempDir, "small.txt")).size).toBeLessThanOrEqual(READ_WHOLE_BUDGET_BYTES);
    const read = tool(tools, "read_file");
    await read.execute({ path: "small.txt" });
    const second = await read.execute({ path: "small.txt" });
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("you already read");
  });

  it("a re-read after the model EDITED the file is also covered (the authored view counts as seen)", async () => {
    const tools = await buildProjectTools(tempDir, undefined, sessionDeps);
    bigFile("big-edit.txt");
    const edit = await tool(tools, "edit_file").execute({
      path: "big-edit.txt",
      oldString: "B0-",
      newString: "X0-",
    });
    expect(edit.ok).toBe(true);
    // No read yet — the WRITE is the model's view; re-reading it is the
    // redundant case the reminder exists for.
    const reRead = await tool(tools, "read_file").execute({ path: "big-edit.txt" });
    expect(reRead.ok).toBe(true);
    expect(reRead.output).toContain("you already read big-edit.txt this session");
  });

  it("sessionless builds never remind (no ledger, no noise for bare/test contexts)", async () => {
    const tools = await buildProjectTools(tempDir);
    bigFile("big-bare.txt");
    const read = tool(tools, "read_file");
    await read.execute({ path: "big-bare.txt" });
    const second = await read.execute({ path: "big-bare.txt" });
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("you already read");
  });
});
