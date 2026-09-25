// @vitest-environment node
//
// ROUND-128 (R128-W7b): AGENT-TOOL RELIABILITY — the validated subset of the
// owner's 18-entry self-feedback ledger (UPLOADED/Feedback.txt), the agent
// tools wave. One file, ten fixes:
//   FIX 1  read_file REBASES absolute paths that live inside the project
//          root (the ledger: "path must be RELATIVE to the project root
//          (got 'C:\Users\…')" twice in one session); outside-root absolutes
//          still refuse — now NAMING the root + a rebased example.
//   FIX 2  run_command distinguishes "no matches" from failure — a search
//          tool exiting 1 with NO output is ok:true with the honest note
//          (the ledger's findstr FAILED: "(no output)").
//   FIX 3  the blocklist names its EXACT matched pattern (decideCommand's
//          reason + the denial note), and curl/wget to LOOPBACK
//          (127.0.0.1 / localhost / [::1], every URL) is no longer blocked.
//   FIX 4  win32 auto-tempfiles for complex inline `node -e "<script>"`
//          payloads ("cmd mangled the quoting") — the rewrite is silent and
//          the temp file ALWAYS goes away; POSIX untouched.
//   FIX 5  edit_file not-found gains line numbers + closest-match context
//          (first-line hit → line N drifted; token overlap → closest line;
//          else the file's line count).
//   FIX 6  background-job log detection never advertises 'nul' — the LAST
//          REAL redirect wins (`> job.log 2>&1 >nul` → job.log).
//   FIX 7  memory_recall dedups near-duplicates — save-side Jaccard ≥ 0.8
//          refreshes the twin row; result-side collapse keeps one row per
//          near-identical cluster (the six-similar-summaries complaint).
//   FIX 8  search_code hints when regex metacharacters were treated as
//          LITERAL text on a zero-match (the regex-dialect query complaint).
//   FIX 9  search_symbols: prefix-first with a CONTAINS fallback + the
//          honest mode note / still-empty teaching hint (query "ch" → 0
//          matches, no hint).
//   FIX 10 run_command's description warns against `2>nul` stderr
//          suppression, and a FAILED suppressed command gets the one-line
//          recovery note (the ledger's lost diagnostic).
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

// FIX 4's lifecycle tests stub process.platform to "win32" so exec.ts's
// planner takes the Windows branch — but Node's own spawn(shell:true) ALSO
// reads process.platform and would route to cmd.exe (absent on this
// runner). The mock below delegates to the REAL spawn with the REAL
// platform restored for the duration of the call (the platform is read
// synchronously inside spawn(); the stub goes right back up), so the child
// runs through the runner's own shell while every OTHER read of
// process.platform (exec.ts's planner, runCommand's paths) still sees the
// stub. Everything else in node:child_process is the untouched real module.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realPlatform = process.platform; // captured at mock-setup time (unstubbed)
  const spawnPatched = (...invokeArgs: unknown[]) => {
    const current = process.platform;
    if (current === realPlatform) {
      return actual.spawn(...(invokeArgs as Parameters<typeof actual.spawn>));
    }
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    try {
      return actual.spawn(...(invokeArgs as Parameters<typeof actual.spawn>));
    } finally {
      Object.defineProperty(process, "platform", { value: current, configurable: true });
    }
  };
  return { ...actual, spawn: spawnPatched };
});

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { createProject } from "../src/storage/projects";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import { editFile, editFileMulti, readFileWindow, resolveInsideRoot, searchCode } from "../src/tools/fs-ops";
import { parseLogRedirect, planWindowsEvalTempFile, runCommand } from "../src/tools/exec";
import { categorize, categorizeWithMatch, decideCommand, requestCommandApproval } from "../src/approvals";
import { listMemories, saveMemoryWithDedup, searchMemories } from "../src/storage/memory";
import { searchIndexSymbols } from "../src/storage/index";

let tempDir = "";
let db: SqliteDatabase | undefined;

// The AI SDK tool contract — narrow to what the tests call (same shape the
// sibling suites use).
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

// ── R104-precedent platform stubbing: process.platform read AT CALL TIME ────
const REAL_PLATFORM = process.platform;
function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
}

/** The eval-tempfile leftovers in the OS temp dir (leak detection). */
function evalTempLeftovers(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("acute-eval-"));
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r128-w7b-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  restorePlatform();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── FIX 1: read_file rebases absolute paths under the root ───────────────── */

describe("R128-W7b FIX 1: resolveInsideRoot rebases INSIDE-root absolute paths", () => {
  it("a POSIX absolute path under the root resolves to the same file (case-insensitive containment)", () => {
    writeFileSync(join(tempDir, "abs.txt"), "absolute-ok\n", "utf8");
    // The exact shape the ledger's agent produced: the FULL path of a file
    // that exists inside the project.
    const result = resolveInsideRoot(tempDir, join(tempDir, "abs.txt"));
    expect("error" in result).toBe(false);
    expect("abs" in result && result.abs).toBe(join(tempDir, "abs.txt"));
    // Mixed case against a lowercase root still resolves (Windows
    // semantics): the containment test is case-insensitive; the SLICE keeps
    // the SUPPLIED casing of the relative part (on a case-insensitive
    // filesystem — the production platform for this complaint — that file
    // IS the file).
    const mixed = resolveInsideRoot(tempDir, `${tempDir.toUpperCase()}/abs.txt`);
    expect("error" in mixed).toBe(false);
    expect("abs" in mixed && mixed.abs).toBe(join(tempDir, "abs.txt"));
    // The root itself.
    expect(resolveInsideRoot(tempDir, tempDir)).toEqual({ abs: tempDir });
  });

  it("a WINDOWS drive-letter path under a drive-letter root rebases (the ledger's exact case)", () => {
    const root = "C:\\Users\\khurr\\Desktop\\CAT\\A\\A";
    const result = resolveInsideRoot(root, "C:\\Users\\khurr\\Desktop\\CAT\\A\\A\\package.json");
    expect("error" in result).toBe(false);
    expect("abs" in result && result.abs).toContain("package.json");
    // Forward-slash spelling + case-insensitive drive/host segments too.
    const slashed = resolveInsideRoot(root, "c:/users/KHURR/desktop/cat/a/a/AGENTS.md");
    expect("error" in slashed).toBe(false);
    expect("abs" in slashed && slashed.abs).toContain("AGENTS.md");
  });

  it("the read_file TOOL reads a file by its absolute path (the ledger complaint verbatim)", () => {
    writeFileSync(join(tempDir, "hello.txt"), "hello absolute\n", "utf8");
    const result = readFileWindow(tempDir, join(tempDir, "hello.txt"));
    expect(result.ok).toBe(true);
    expect(result.output).toBe("     1  hello absolute");
  });

  it("an absolute path OUTSIDE the root still refuses — now NAMING the root + a rebased example", () => {
    const result = resolveInsideRoot(tempDir, "/absolute/path.txt");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("path must be INSIDE the project root");
      expect(result.error).toContain(tempDir);
      expect(result.error).toContain("use a path relative to the project root, e.g. 'absolute/path.txt'");
      expect(result.error).toContain("(got '/absolute/path.txt')");
    }
    // Same drive, outside the root: the example is computable there too.
    const winRoot = resolveInsideRoot("C:\\Users\\me\\proj", "C:\\Windows\\evil.txt");
    expect("error" in winRoot).toBe(true);
    if ("error" in winRoot) {
      expect(winRoot.error).toContain("INSIDE the project root 'C:\\Users\\me\\proj'");
      expect(winRoot.error).toContain("e.g. 'windows/evil.txt'");
    }
  });

  it("a DIFFERENT-DRIVE / ancestor path keeps the no-example message but still NAMES the root", () => {
    // A Windows path against a POSIX root (the dev-sandbox shape) — no
    // rebased example is computable across shapes, but the root is named
    // either way (successor-audit amendment: the letter's "NAMES the root"
    // applies to EVERY refusal, and a different-drive escape is exactly
    // when the model most needs to see where "inside" starts).
    const cross = resolveInsideRoot(tempDir, "C:\\Windows\\evil.txt");
    expect("error" in cross).toBe(true);
    if ("error" in cross) {
      expect(cross.error).toContain("path must be RELATIVE to the project root");
      expect(cross.error).toContain(tempDir);
      expect(cross.error).not.toContain("INSIDE the project root");
    }
    // An ANCESTOR of the root (posix.relative is all ".."s — nothing to show).
    const ancestor = resolveInsideRoot(tempDir, dirname(tempDir));
    expect("error" in ancestor).toBe(true);
    if ("error" in ancestor) {
      expect(ancestor.error).toContain("path must be RELATIVE to the project root");
      expect(ancestor.error).toContain(tempDir);
    }
  });

  it("an absolute path that escapes via embedded '..' is still REFUSED (containment strength unchanged)", () => {
    expect("error" in resolveInsideRoot(tempDir, `${tempDir}/../escape.txt`)).toBe(true);
    expect("error" in resolveInsideRoot(tempDir, `${tempDir}/sub/../../escape.txt`)).toBe(true);
  });
});

/* ── FIX 2: run_command's "no matches" ≠ failure ──────────────────────────── */

describe("R128-W7b FIX 2: search tools exiting 1 with no output are 'no matches'", () => {
  it("grep with no matches → ok:true + the honest note", async () => {
    writeFileSync(join(tempDir, "haystack.txt"), "needle is not here\n", "utf8");
    const result = await runCommand(tempDir, "grep zzz-never-matching haystack.txt");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("(no matches — grep exits 1 when nothing matches)");
  }, 15_000);

  it("findstr (a fake on the PATH for this test) with no matches → ok:true + the note naming findstr", async () => {
    // Windows' findstr does not exist on the POSIX runner — a stub with the
    // exact contract (silent, exit 1) rides the PATH for this one test.
    const stub = join(tempDir, "findstr");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(stub, 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${tempDir}:${realPath ?? ""}`;
    try {
      writeFileSync(join(tempDir, "win.txt"), "windows haystack\n", "utf8");
      const result = await runCommand(tempDir, "findstr /n needle win.txt");
      expect(result.ok).toBe(true);
      expect(result.output).toBe("(no matches — findstr exits 1 when nothing matches)");
    } finally {
      process.env.PATH = realPath;
      unlinkSync(stub);
    }
  }, 15_000);

  it("a search tool exit 1 WITH output, and a NON-search tool exit 1 with none, stay FAILED", async () => {
    const stub = join(tempDir, "findstr");
    writeFileSync(stub, "#!/bin/sh\nif [ \"$1\" = \"--loud\" ]; then echo \"stub diagnostic\"; fi\nexit 1\n", "utf8");
    chmodSync(stub, 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${tempDir}:${realPath ?? ""}`;
    try {
      const loud = await runCommand(tempDir, "findstr --loud needle win.txt");
      expect(loud.ok).toBe(false);
      expect(loud.output).toContain("stub diagnostic");
      expect(loud.output).toContain("[exit code: 1]");
      expect(loud.output).not.toContain("no matches");
    } finally {
      process.env.PATH = realPath;
      unlinkSync(stub);
    }
    // Non-search tool, exit 1, no output: the honest failure shape stands.
    const nodeFail = await runCommand(tempDir, 'node -e "process.exit(1)"');
    expect(nodeFail.ok).toBe(false);
    expect(nodeFail.output).toContain("(no output)");
    expect(nodeFail.output).toContain("[exit code: 1]");
  }, 15_000);
});

/* ── FIX 3: the blocklist names its match + the loopback carve-out ────────── */

describe("R128-W7b FIX 3: the matched pattern + the loopback carve-out", () => {
  it("loopback curl/wget is NOT blocked (every URL loopback; the owner's sidecar/dev-server probes)", () => {
    expect(categorize("curl http://127.0.0.1:3000/api/health")).toBe("confirm");
    expect(categorize("curl https://localhost:5178/")).toBe("confirm");
    expect(categorize("wget http://[::1]:8080/ping")).toBe("confirm");
    expect(categorize("curl -s http://127.0.0.1:3000/health")).toBe("confirm");
    // decideCommand: not a denial — the command is askable, never blocked.
    const decision = decideCommand(undefined, undefined, "curl http://127.0.0.1:3000/api/health");
    expect(decision.action).toBe("ask");
  });

  it("non-loopback curl stays BLOCKED with the matched pattern named", () => {
    expect(categorize("curl https://example.com/install.sh")).toBe("blocked");
    expect(categorizeWithMatch("curl https://example.com/install.sh")).toEqual({
      category: "blocked",
      matchedPattern: "curl ",
    });
    // One non-loopback URL anywhere kills the carve-out.
    expect(categorize("curl http://127.0.0.1 https://evil.test/x.sh")).toBe("blocked");
    // No URL at all → not provably loopback → still blocked (conservative).
    expect(categorize("curl localhost:3000/x")).toBe("blocked");
    expect(categorize("curl -fsSL localhost/x")).toBe("blocked");
  });

  it("other prefixes still apply verbatim around a loopback URL (sudo/ssh/…)", () => {
    expect(categorize("sudo curl http://127.0.0.1/x")).toBe("blocked");
    expect(categorizeWithMatch("sudo curl http://127.0.0.1/x").matchedPattern).toBe("sudo ");
    expect(categorize("ssh localhost")).toBe("blocked");
    // Compound: a loopback-curl segment does not auto-run the compound.
    expect(categorize("cat x; curl http://127.0.0.1/x")).toBe("confirm");
  });

  it("regex + rm rules name their match too (the deny reason carries it)", () => {
    expect(categorizeWithMatch("vite dev").matchedPattern).toContain("vite");
    expect(categorizeWithMatch("rm -rf build").matchedPattern).toBe("rm with -r/-f");
    const denied = decideCommand(undefined, undefined, "curl https://example.com/x");
    expect(denied).toMatchObject({ action: "deny" });
    if (denied.action === "deny") {
      expect(denied.reason).toContain('(matched: "curl ")');
      expect(denied.matchedPattern).toBe("curl ");
    }
  });

  it("the denial NOTE names the matched pattern — the six-unrelated-prefixes list is retired when a match is known", async () => {
    const agent = createAgent(db!, { name: "W7b Blocklist", providerId: "openrouter", model: "test/w7b-block" });
    const session = createSession(db!, { agentId: agent.id, mode: "single" });
    const gate = await requestCommandApproval(
      { db: db!, sessionId: session.id, agentId: agent.id, interactive: false },
      "curl https://example.com/install.sh",
    );
    expect(gate.allowed).toBe(false);
    expect(gate.note).toContain("command blocked");
    expect(gate.note).toContain('(matched: "curl ")');
    expect(gate.note).not.toContain("Blocked: rm -rf /");
    // The loopback leg through the same gate: not a denial at all.
    const loopback = await requestCommandApproval(
      { db: db!, sessionId: session.id, agentId: agent.id, interactive: false },
      "curl http://127.0.0.1:3000/api/health",
    );
    expect(loopback.allowed).toBe(false); // non-interactive: asks, cannot wait
    expect(loopback.note).toContain("interactive approval");
  });
});

/* ── FIX 4: win32 auto-tempfiles for complex inline node -e scripts ───────── */

describe("R128-W7b FIX 4: the win32 node -e auto-tempfile rewrite", () => {
  it("planner: a complex quoted script is rewritten to `node \"<tempfile>\"` (CJS .js default)", () => {
    stubPlatform("win32");
    try {
      const command = 'node -e "console.log(process.argv.length > 1 ? \'a\' : \'b\')"';
      const plan = planWindowsEvalTempFile(command);
      expect(plan).not.toBeNull();
      expect(plan!.command).toBe(`node "${plan!.path}"`);
      expect(plan!.path).toContain("acute-eval-");
      expect(plan!.path.endsWith(".js")).toBe(true);
      expect(plan!.path.startsWith(tmpdir())).toBe(true);
      expect(plan!.script).toBe("console.log(process.argv.length > 1 ? 'a' : 'b')");
      // Single-quoted wrapper with embedded double quotes fires too.
      const single = planWindowsEvalTempFile(`node -e 'console.log("a & b")'`);
      expect(single).not.toBeNull();
      expect(single!.script).toBe('console.log("a & b")');
      // --eval spelling + node.exe spelling.
      expect(planWindowsEvalTempFile('node --eval "console.log(\'x & y\')"')).not.toBeNull();
      expect(planWindowsEvalTempFile('node.exe -e "console.log(\'x & y\')"')).not.toBeNull();
      // ESM-shaped body → .mjs (node -e auto-detects those on modern Node).
      const esm = planWindowsEvalTempFile(`node -e "import { readFile } from 'node:fs'"`);
      expect(esm).not.toBeNull();
      expect(esm!.path.endsWith(".mjs")).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("planner: benign shapes stay untouched (no metachars / trailing args / background / posix)", () => {
    expect(planWindowsEvalTempFile('node -e "console.log(1)"', { background: true })).toBeNull();
    stubPlatform("win32");
    try {
      // A clean script cmd can carry — no rewrite needed.
      expect(planWindowsEvalTempFile('node -e "console.log(1)"')).toBeNull();
      // Trailing arguments after the script: cannot reconstruct safely.
      expect(planWindowsEvalTempFile('node -e "console.log(\'x\')" --flag')).toBeNull();
      // A background launch never rewrites (the detached grandchild would
      // race the temp-file deletion).
      expect(planWindowsEvalTempFile('node -e "console.log(\'x & y\')"', { background: true })).toBeNull();
      // Not a node -e shape at all.
      expect(planWindowsEvalTempFile('node script.js "a & b"')).toBeNull();
    } finally {
      restorePlatform();
    }
    // POSIX: never rewritten, whatever the payload.
    expect(planWindowsEvalTempFile('node -e "console.log(\'a & b\')"')).toBeNull();
  });

  it("lifecycle (win32-stubbed, real spawn): the script RUNS from the temp file and the temp file is deleted on SUCCESS", async () => {
    const before = evalTempLeftovers();
    stubPlatform("win32");
    try {
      // The discriminator: process.argv[1] exists ONLY when node runs a FILE
      // (node -e sees argv.length === 1). If the rewrite fires, the script
      // prints ran-from-file; if it silently did not, ran-from-eval.
      const result = await runCommand(
        tempDir,
        'node -e "console.log(process.argv.length > 1 ? \'ran-from-file\' : \'ran-from-eval\')"',
      );
      expect(result.ok).toBe(true);
      expect(result.output).toBe("ran-from-file");
    } finally {
      restorePlatform();
    }
    expect(evalTempLeftovers()).toEqual(before);
  }, 15_000);

  it("lifecycle (win32-stubbed): FAILURE still cleans the temp file (and keeps the exit code honest)", async () => {
    const before = evalTempLeftovers();
    stubPlatform("win32");
    try {
      const result = await runCommand(
        tempDir,
        'node -e "console.log(process.argv.length > 1 ? \'file\' : \'eval\'); process.exit(3)"',
      );
      expect(result.ok).toBe(false);
      expect(result.output).toContain("file");
      expect(result.output).toContain("[exit code: 3]");
    } finally {
      restorePlatform();
    }
    expect(evalTempLeftovers()).toEqual(before);
  }, 15_000);

  it("POSIX untouched: the same command runs through node -e verbatim (argv length 1)", async () => {
    const result = await runCommand(
      tempDir,
      'node -e "console.log(process.argv.length > 1 ? \'ran-from-file\' : \'ran-from-eval\')"',
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("ran-from-eval");
  }, 15_000);
});

/* ── FIX 5: edit_file not-found gains line numbers + context ──────────────── */

describe("R128-W7b FIX 5: the not-found recipe names WHERE the anchor drifted", () => {
  it("a drifted anchor (same first line) names the file line", () => {
    writeFileSync(
      join(tempDir, "drift.txt"),
      ["line one alpha", "line two beta", "line three gamma"].join("\n") + "\n",
      "utf8",
    );
    const result = editFile(tempDir, "drift.txt", "line one alpha\nline two DELTA", "x");
    expect(result.ok).toBe(false);
    // The R127 recipe text is intact (prefix + advice + echo)…
    expect(result.output.startsWith("edit failed: oldString not found in 'drift.txt'")).toBe(true);
    expect(result.output).toContain("re-read JUST the region");
    expect(result.output).toContain('you tried to match: "line one alpha"');
    // …and the R128 line fact follows it.
    expect(result.output).toContain("the file's line 1 starts with the same first line — the anchor likely drifted below/above it");
  });

  it("a fuzzy near-miss names the closest line by token overlap (≥40%)", () => {
    writeFileSync(
      join(tempDir, "fuzzy.txt"),
      ["unrelated opener", "the quick brown fox sleeps all day", "totally other content"].join("\n") + "\n",
      "utf8",
    );
    const result = editFile(tempDir, "fuzzy.txt", "the quick brown fox jumps over stuff", "x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain('closest match: line 2: "the quick brown fox sleeps all day"');
    expect(result.output).not.toContain("starts with the same first line");
  });

  it("no reasonable match names the file's LINE COUNT", () => {
    writeFileSync(join(tempDir, "count.txt"), "aaa\nbbb\nccc\nddd\n", "utf8");
    const result = editFile(tempDir, "count.txt", "zzz qqq xxx", "x");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("the file has 4 lines — no close match for the anchor was found");
  });

  it("the BATCH form carries the same line facts (the evolving content threads in)", () => {
    writeFileSync(join(tempDir, "batch.txt"), "alpha start\nbeta middle\ngamma end\n", "utf8");
    const result = editFileMulti(tempDir, "batch.txt", [
      { oldString: "beta middle", newString: "BETA" },
      { oldString: "gamma end\nand more", newString: "G" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("edits[1]");
    expect(result.output).toContain("NO changes were applied");
    expect(result.output).toContain('you tried to match: "gamma end"');
    expect(result.output).toContain("the file's line 3 starts with the same first line");
    // The file is untouched (the atomic-batch law).
    expect(readFileSync(join(tempDir, "batch.txt"), "utf8")).toBe("alpha start\nbeta middle\ngamma end\n");
  });
});

/* ── FIX 6: never advertise 'nul' as the job log ──────────────────────────── */

describe("R128-W7b FIX 6: parseLogRedirect skips the null device, prefers the last REAL redirect", () => {
  it("the ledger's exact shape: a real log + a trailing >nul → the real log wins", () => {
    expect(parseLogRedirect("cmd > log 2>&1 >nul")).toBe("log");
    expect(parseLogRedirect("start /B node app.js > job.log 2>&1 >nul")).toBe("job.log");
    expect(parseLogRedirect("cmd > TEST-1\\job.log 2>&1 >nul")).toBe("TEST-1\\job.log");
  });

  it("all-null shapes advertise NO log at all", () => {
    expect(parseLogRedirect("cmd >nul 2>&1")).toBeNull();
    expect(parseLogRedirect("cmd >NUL")).toBeNull();
    expect(parseLogRedirect("node app.js > /dev/null 2>&1")).toBeNull();
  });

  it("multiple REAL redirects: the LAST one wins (the old first-match parse kept the first)", () => {
    expect(parseLogRedirect("cmd >> log1.txt > log2.txt")).toBe("log2.txt");
  });

  it("the pre-R128 pins survive byte-exact (single real redirect shapes)", () => {
    expect(parseLogRedirect("start /B node server.js > server.log 2>&1")).toBe("server.log");
    expect(parseLogRedirect("node app.js >> out.log 2>&1")).toBe("out.log");
    expect(parseLogRedirect('node app.js > "my log.txt"')).toBe("my log.txt");
    expect(parseLogRedirect("node app.js 2>&1")).toBeNull();
    expect(parseLogRedirect("echo hello")).toBeNull();
  });
});

/* ── FIX 7: memory near-duplicate dedup (save + recall) ───────────────────── */

describe("R128-W7b FIX 7: near-duplicate memories dedup (Jaccard ≥ 0.8, tiny rows exempt)", () => {
  it("save: a ≥0.8-similar note refreshes the existing row (content becomes the NEWEST wording)", () => {
    const first = saveMemoryWithDedup(db!, {
      projectId: "prj_w7b",
      kind: "note",
      content: "the coral reef session summarized the deployment pipeline steps for the team",
    });
    expect(first.deduplicated).toBe(false);
    // One appended word: token-set Jaccard 10/11 ≈ 0.91.
    const second = saveMemoryWithDedup(db!, {
      projectId: "prj_w7b",
      kind: "note",
      content: "the coral reef session summarized the deployment pipeline steps for the team carefully",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.content).toContain("carefully");
    expect(listMemories(db!, "prj_w7b")).toHaveLength(1);
  });

  it("save: ~0.5-similar notes are DIFFERENT memories (two rows)", () => {
    saveMemoryWithDedup(db!, { projectId: "prj_w7b2", content: "one two three four five six" });
    saveMemoryWithDedup(db!, { projectId: "prj_w7b2", content: "one two three four seven eight" });
    expect(listMemories(db!, "prj_w7b2")).toHaveLength(2);
    // Tiny rows never near-dedup (the "fact N" listing grammar).
    saveMemoryWithDedup(db!, { projectId: "prj_w7b3", content: "fact 0" });
    saveMemoryWithDedup(db!, { projectId: "prj_w7b3", content: "fact 1" });
    expect(listMemories(db!, "prj_w7b3")).toHaveLength(2);
  });

  it("save: the near-dup rung never crosses SCOPES (project vs workspace)", async () => {
    saveMemoryWithDedup(db!, { projectId: "prj_w7b4", content: "always run the full test suite before pushing changes" });
    saveMemoryWithDedup(db!, {
      projectId: null,
      scope: "workspace",
      content: "always run the full test suite before pushing changes carefully",
    });
    expect(listMemories(db!, "prj_w7b4")).toHaveLength(1);
    const { listWorkspaceMemories } = await import("../src/storage/memory");
    expect(listWorkspaceMemories(db!)).toHaveLength(1);
  });

  it("recall: six near-identical summaries collapse to ONE result (the ledger's 'six very similar session summaries')", () => {
    // Insert six rows DIRECTLY (bypassing the save rung — this pins the
    // RESULT-side collapse independently): the same 14 tokens + a differing
    // final word → every pair is Jaccard 14/16 = 0.875.
    const shared =
      "coral reef monitoring session summary covers deployment pipeline health checks alerts dashboards retries and";
    const finals = ["backoff", "latency", "throughput", "timeouts", "failures", "warmup"];
    const insert = db!.prepare(
      `INSERT INTO memory (id, project_id, scope, kind, content, source, created_at, updated_at)
       VALUES (?, ?, 'project', 'note', ?, 'agent', ?, ?)`,
    );
    finals.forEach((finalWord, i) => {
      const at = `2026-09-2${i}T00:00:00.000Z`;
      insert.run(`mem_w7b_${i}`, "prj_w7b5", `${shared} ${finalWord}`, at, at);
    });
    const results = searchMemories(db!, "prj_w7b5", "coral");
    // The letter's bound: ≤2 when all six are ≥0.8 mutual — the collapse
    // leaves exactly ONE, and it is the NEWEST wording.
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(1);
    expect(results[0].content.endsWith("warmup")).toBe(true);
  });

  it("recall: genuinely different memories all survive the collapse (the scored path)", () => {
    saveMemoryWithDedup(db!, { projectId: "prj_w7b6", content: "coral bleaching is a temperature event" });
    saveMemoryWithDedup(db!, { projectId: "prj_w7b6", content: "coral reef restoration uses thermal stress data" });
    saveMemoryWithDedup(db!, { projectId: "prj_w7b6", content: "coral taxonomy orders reef species globally" });
    const results = searchMemories(db!, "prj_w7b6", "coral");
    expect(results).toHaveLength(3);
  });
});

/* ── FIX 8: search_code's metacharacter hint on a literal zero-match ──────── */

describe("R128-W7b FIX 8: literal-mode zero-match with regex metacharacters hints", () => {
  it("the ledger's regex-dialect query (`\\.row|\\.col`, 0 matches) gets the hint", () => {
    writeFileSync(join(tempDir, "grid.css"), "css .row { color: red }\ncss .col { float: left }\n", "utf8");
    const result = searchCode(tempDir, "\\.row|\\.col");
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      "no content matches for '\\.row|\\.col'\n" +
        "(hint: your query contains regex metacharacters which were treated as LITERAL text — pass regex:true if you meant a pattern)",
    );
    // With regex:true the pattern MEANT something and matches honestly.
    const asPattern = searchCode(tempDir, "\\.row|\\.col", undefined, { regex: true });
    expect(asPattern.ok).toBe(true);
    expect(asPattern.output).toContain("grid.css:1:");
    expect(asPattern.output).toContain("grid.css:2:");
  });

  it("a clean literal zero-match stays the plain honest empty result (no hint)", () => {
    writeFileSync(join(tempDir, "clean.txt"), "nothing here\n", "utf8");
    expect(searchCode(tempDir, "zzz-clean").output).toBe("no content matches for 'zzz-clean'");
    // Neither does a metachar-bearing needle that FOUND literal matches.
    const found = searchCode(tempDir, "a.b");
    expect(found.ok).toBe(true);
    expect(found.output).not.toContain("(hint:");
  });
});

/* ── FIX 9: search_symbols prefix-first + contains fallback + hints ───────── */

describe("R128-W7b FIX 9: search_symbols contains fallback + the honest mode notes", () => {
  let root = "";
  let sessionDeps: ToolDeps;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "acute-r128-w7b-sym-"));
    const project = createProject(db!, { name: "W7b Symbols", rootPath: root });
    const agent = createAgent(db!, { name: "W7b Sym Agent", providerId: "openrouter", model: "test/w7b-sym" });
    const session = createSession(db!, { agentId: agent.id, mode: "single", projectId: project.id });
    sessionDeps = { db: db!, sessionId: session.id, agentId: agent.id, projectId: project.id };
    writeFileSync(
      join(root, "cfg.ts"),
      "export function loadConfig(): number {\n  return 1;\n}\nexport function readConfig(): string {\n  return 'x';\n}\n",
      "utf8",
    );
  });

  it("a PREFIX hit renders exactly as before (no substring note)", async () => {
    const tools = await buildProjectTools(root, undefined, sessionDeps);
    await tool(tools, "index_project").execute({});
    const result = await tool(tools, "search_symbols").execute({ query: "load" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[function] loadConfig");
    expect(result.output).not.toContain("readConfig");
    expect(result.output).not.toContain("match by substring");
    // Storage-level: the mode marker says prefix.
    const rows = searchIndexSymbols(db!, sessionDeps.projectId!, "load");
    expect(rows).toHaveLength(1);
    expect(rows.matchMode).toBe("prefix");
  });

  it("a mid-word query ('config') falls back to CONTAINS and says so on one line", async () => {
    const tools = await buildProjectTools(root, undefined, sessionDeps);
    await tool(tools, "index_project").execute({});
    const result = await tool(tools, "search_symbols").execute({ query: "config" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[function] loadConfig");
    expect(result.output).toContain("[function] readConfig");
    expect(result.output).toContain("(2 symbols match by substring — symbol search is prefix-first)");
    const rows = searchIndexSymbols(db!, sessionDeps.projectId!, "config");
    expect(rows).toHaveLength(2);
    expect(rows.matchMode).toBe("contains");
  });

  it("a query that matches NOTHING gets the teaching hint (the ledger's 'ch' → 0 matches, no hint)", async () => {
    const tools = await buildProjectTools(root, undefined, sessionDeps);
    await tool(tools, "index_project").execute({});
    const result = await tool(tools, "search_symbols").execute({ query: "zz" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("0 matches for 'zz'");
    expect(result.output).toContain(
      "(no matching symbols — matching is PREFIX-first with a contains fallback; for content search use search_code)",
    );
  });
});

/* ── FIX 10: the 2>nul stderr-suppression warning ─────────────────────────── */

describe("R128-W7b FIX 10: stderr suppression is warned against (description + failure note)", () => {
  it("run_command's description carries the never-suppress-stderr sentence", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "run_command").description;
    expect(desc).toContain("Never append `2>nul` / `2>/dev/null` — it discards the error output you need to diagnose failures");
  });

  it("a FAILED command with 2>nul gets the one-line recovery note; success stays silent", async () => {
    const failing = await runCommand(tempDir, 'node -e "process.exit(3)" 2>nul');
    expect(failing.ok).toBe(false);
    expect(failing.output).toContain("[exit code: 3]");
    expect(failing.output).toContain("[note: the command suppressed stderr with 2>nul — remove it to see the actual error]");
    // Success with the same suppression: no note (nothing was lost).
    const succeeding = await runCommand(tempDir, "node -e \"console.log('nul-quiet-ok')\" 2>nul");
    expect(succeeding.ok).toBe(true);
    expect(succeeding.output).toBe("nul-quiet-ok");
    // A failure WITHOUT suppression: no note either.
    const plain = await runCommand(tempDir, 'node -e "process.exit(4)"');
    expect(plain.ok).toBe(false);
    expect(plain.output).not.toContain("[note:");
    // The `nul` file sh creates as the redirect target: cleaned up here.
    const nulFile = join(tempDir, "nul");
    if (existsSync(nulFile)) unlinkSync(nulFile);
  }, 15_000);
});
