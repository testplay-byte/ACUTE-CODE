/**
 * ROUND-70 (R70-c): THE PROMPT ROUND — pins for every deliverable:
 *
 *   D1 — ENVIRONMENT GROUNDING: the ENVIRONMENT section renders the turn's
 *        real OS/shell/date/git (prepareTurn computes it; env-absent callers
 *        keep the legacy working-dir-only lines), the TERMINAL section is
 *        OS-aware (only the actual platform's background-launch syntax when
 *        env is known), and the git probe NEVER blocks the turn (honest
 *        fallbacks; a real repo reports branch + dirty state).
 *   D2 — FOUR-SECTION CONSOLIDATION: the maximal composition carries ONE
 *        agentic-loop (five phases) and NO efficiency/task-planning/
 *        todo-tracking sections (also pinned in prompt-registry.test.ts).
 *   D3 — AGENTS.md/CLAUDE.md LOADING: readCustomRules reads the six
 *        convention sources in order with `# <file>:` markers, expands
 *        @file imports (relative to the including file, .md/.txt only,
 *        max 4 total, cycle-safe, cross-file dedupe), and keeps the
 *        16K/32K caps. The custom-rules section narrates the hierarchy.
 *   D4 — FILE EDITING UPGRADES: line-number-prefix rule, dirty-worktree
 *        discipline + verify-after-edit (tool-gated), prefer-editing.
 *   D5 — COMMUNICATION: the verbosity contract + path:line citations + the
 *        what/verification/next final-reply shape.
 *   D6 — PANEL TRIMS: browser-panel/computer-use are materially smaller and
 *        end with their read_skill pointers; the SKILLS section teaches the
 *        reload affordance.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProjectSystemPrompt,
  buildSectionText,
  readCustomRules,
  type PromptContext,
  type PromptEnvironment,
} from "../src/agents/prompts";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import type { StreamChatEvent } from "../src/agents/chat";
import { TOOL_NAMES, createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { createSession } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-or-vtest-r70c";

/** Is a git binary actually available? (The real-repo pins need it; the
 * not-a-repo fallback pins produce a specific string only when git exists
 * to say "not a git repository" — otherwise the probe honestly reports
 * "unknown".) */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

afterAll(() => {
  try {
    rmSync(join(tmpdir(), "acute-r70c-"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Fresh project root for the convention-file fixtures. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "acute-r70c-"));
}

const BASE_ENV: PromptEnvironment = {
  osPlatform: "Linux",
  osRelease: "6.5.0-r70c",
  shell: "/bin/sh",
  currentDate: "2026-06-11 (Thursday)",
  gitBranch: "main",
  gitDirty: true,
};

/** A maximal-ish ctx: every relevant gate open, env pinned. */
function ctxFor(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "R70cProject",
    rootPath: "/tmp/acute-r70c-never-exists",
    toolNames: [...TOOL_NAMES],
    maxTurns: 40,
    maxOuterLoops: 5,
    environment: { ...BASE_ENV },
    customRules: "Always write tests first.",
    ...overrides,
  };
}

// ── D1: ENVIRONMENT GROUNDING ────────────────────────────────────────────────

describe("D1: the ENVIRONMENT section renders the turn's real machine state", () => {
  it("OS + release, shell, working dir, date, git branch + dirty state all render", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    const envIdx = composed.indexOf("## ENVIRONMENT");
    expect(envIdx).toBeGreaterThan(-1);
    const rest = composed.slice(envIdx, envIdx + 600);
    expect(rest).toContain("- OS: Linux (release 6.5.0-r70c); shell: /bin/sh — run_command runs commands through that shell.");
    expect(rest).toContain("- Working directory: /tmp/acute-r70c-never-exists (ALL paths must be relative to this)");
    expect(rest).toContain("- Current date: 2026-06-11 (Thursday)");
    expect(rest).toContain("- Git: branch main, dirty — uncommitted changes present (the USER's work: NEVER revert or discard them)");
    // The path discipline lines stay.
    expect(rest).toContain("Never use absolute paths — always relative to the project root");
    expect(rest).toContain("Never access files outside the project root");
  });

  it("clean repo + the honest fallbacks (not a git repo / unknown)", () => {
    const clean = buildProjectSystemPrompt(ctxFor({ environment: { ...BASE_ENV, gitDirty: false } }));
    expect(clean).toContain("- Git: branch main, clean");
    const noRepo = buildProjectSystemPrompt(ctxFor({ environment: { ...BASE_ENV, gitBranch: "not a git repo", gitDirty: false } }));
    expect(noRepo).toContain("- Git: this project is not a git repo (no branch state to respect).");
    const unknown = buildProjectSystemPrompt(ctxFor({ environment: { ...BASE_ENV, gitBranch: "unknown", gitDirty: false } }));
    expect(unknown).toContain("- Git: branch unknown (probe failed — check git_status before relying on branch state).");
  });

  it("env absent → the legacy working-dir-only lines (old callers stay byte-identical)", () => {
    const legacy = buildProjectSystemPrompt(ctxFor({ environment: undefined }));
    const envIdx = legacy.indexOf("## ENVIRONMENT");
    const rest = legacy.slice(envIdx, envIdx + 300);
    expect(rest).toContain("- Working directory: /tmp/acute-r70c-never-exists (ALL paths must be relative to this)");
    expect(rest).not.toContain("- OS:");
    expect(rest).not.toContain("- Current date:");
    expect(rest).not.toContain("- Git:");
  });
});

describe("D1: the TERMINAL section is OS-aware", () => {
  const terminalSection = (ctx: PromptContext): string =>
    buildSectionText(ctx, "terminal") ?? "";

  it("Linux/macOS env → POSIX syntax ONLY (no start /B)", () => {
    const term = terminalSection(ctxFor({ environment: { ...BASE_ENV, osPlatform: "Linux", shell: "/bin/sh" } }));
    expect(term).toContain("SERVERS / LONG-RUNNING PROCESSES");
    expect(term).toContain("`<cmd> > <log> 2>&1 &` (POSIX shell syntax; the shell is /bin/sh)");
    expect(term).not.toContain("start /B");
    // The background-job contract still matches exec.ts (launch detached →
    // job_status verify → poll → job_stop → [background job]/[timeout] meaning).
    expect(term).toContain("call job_status with the job id");
    expect(term).toContain("job_stop with the job id");
    expect(term).toContain("[background job …] or [timeout]");
  });

  it("Windows env → cmd.exe syntax ONLY (no POSIX &)", () => {
    const term = terminalSection(
      ctxFor({ environment: { ...BASE_ENV, osPlatform: "Windows", shell: "cmd.exe" } }),
    );
    expect(term).toContain("`start /B <cmd> > <log> 2>&1` (cmd.exe syntax; the shell is cmd.exe)");
    expect(term).not.toContain("2>&1 &`");
    expect(term).not.toContain("POSIX shell syntax");
  });

  it("env absent → the legacy both-platforms line", () => {
    const term = terminalSection(ctxFor({ environment: undefined }));
    expect(term).toContain("Windows: `start /B <cmd> > <log> 2>&1`; Unix: `<cmd> > <log> 2>&1 &`");
  });
});

describe("D1: prepareTurn grounds the live turn (git probe never blocks)", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(join(tmpdir(), `acute-r70c-${randomUUID()}.db`));
  });
  afterEach(() => {
    db.close();
  });

  /** Run one streamed turn and capture the system prompt. When projectId is
   * given, reuse the project (root_path is UNIQUE — two captures on the
   * same root must share the project row). */
  async function captureSystem(rootPath: string, call: number, projectId?: string): Promise<string> {
    const project =
      projectId !== undefined
        ? { id: projectId, name: `R70c Env ${call}`, rootPath }
        : createProject(db, { name: `R70c Env ${call}`, rootPath });
    const agent = createAgent(db, { name: `Env Agent ${call}`, providerId: "openrouter", model: "test/model-1" });
    const sessionId = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] })) as never,
      chatStream: (input: { system: string }) => {
        captured.system = input.system;
        return (async function* (): AsyncGenerator<StreamChatEvent> {
          yield { type: "text-delta", delta: "done." };
          yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })();
      },
    };
    const outcome = await runStreamedAgentTurn(deps, sessionId, "ground me", () => undefined);
    expect(outcome.ok).toBe(true); // the probe NEVER fails the turn
    return captured.system;
  }

  it("a temp root that is not a repo → the honest fallback + real OS/shell/date", async () => {
    const system = await captureSystem(tempRoot(), 1);
    expect(system).toContain("## ENVIRONMENT");
    expect(system).toMatch(/- OS: (Windows|macOS|Linux) \(release [^)]+\); shell: (cmd\.exe|\/bin\/sh) — run_command runs commands through that shell\./);
    expect(system).toMatch(/- Current date: \d{4}-\d{2}-\d{2} \((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\)/);
    // The shell is the one exec.ts actually spawns through (shell:true).
    expect(system).toContain(
      process.platform === "win32" ? "shell: cmd.exe" : "shell: /bin/sh",
    );
    if (HAS_GIT) {
      expect(system).toContain("this project is not a git repo");
    } else {
      expect(system).toContain("branch unknown");
    }
  });

  it("a REAL git repo → branch + dirty state, flipping with the worktree", async () => {
    const root = tempRoot();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", timeout: 10_000 });
    git("init", "-q");
    git("config", "user.email", "r70c@test");
    git("config", "user.name", "R70-c");
    writeFileSync(join(root, "a.txt"), "one");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    // One project row for the shared root (root_path is UNIQUE).
    const shared = createProject(db, { name: "R70c GitRepo", rootPath: root });
    // Clean: branch named, clean.
    const clean = await captureSystem(root, 2, shared.id);
    expect(clean).toMatch(/- Git: branch (main|master), clean/);
    // Dirty: one uncommitted file flips it.
    writeFileSync(join(root, "b.txt"), "uncommitted");
    const dirty = await captureSystem(root, 3, shared.id);
    expect(dirty).toMatch(/- Git: branch (main|master), dirty — uncommitted changes present/);
  });

  it("the AGENTIC LOOP's outer-iteration line reflects the agent default", async () => {
    const system = await captureSystem(tempRoot(), 4);
    expect(system).toContain("outer iterations exist — keep working within them");
  });
});

// ── D2: CONSOLIDATION (composition-level; registry pins live in prompt-registry) ──

describe("D2: the four-way overlap is ONE section", () => {
  it("the maximal composition has no EFFICIENCY / TASK PLANNING / TODO TRACKING sections", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    for (const gone of ["## EFFICIENCY", "## TASK PLANNING", "## TODO TRACKING"]) {
      expect(composed).not.toContain(gone);
    }
  });

  it("the default maxOuterLoops is 5 when the ctx omits it", () => {
    const composed = buildProjectSystemPrompt(ctxFor({ maxOuterLoops: undefined }));
    expect(composed).toContain("5 outer iterations exist — keep working within them");
  });
});

// ── D3: AGENTS.md / CLAUDE.md CONVENTION LOADING ─────────────────────────────

describe("D3: readCustomRules loads the ecosystem convention files", () => {
  it("AGENTS.md alone loads, with its source marker", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "Use pnpm. Never commit directly.", "utf8");
    const rules = readCustomRules(root);
    expect(rules).toBeDefined();
    expect(rules).toContain("# AGENTS.md:");
    expect(rules).toContain("Use pnpm. Never commit directly.");
  });

  it("CLAUDE.md alone loads too", () => {
    const root = tempRoot();
    writeFileSync(join(root, "CLAUDE.md"), "We prefer vitest.", "utf8");
    const rules = readCustomRules(root);
    expect(rules).toContain("# CLAUDE.md:");
    expect(rules).toContain("We prefer vitest.");
  });

  it("the FULL composition order: AGENTS.md → CLAUDE.md → .acute/rules/*.md → .acuterules → AGENTS.override.md → CLAUDE.local.md", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".acute", "rules"), { recursive: true });
    for (const [file, body] of [
      ["AGENTS.md", "A-agents"],
      ["CLAUDE.md", "C-claude"],
      [".acute/rules/b-rule.md", "B-second-rule"],
      [".acute/rules/a-rule.md", "A-first-rule"],
      [".acuterules", "R-acute"],
      ["AGENTS.override.md", "O-agents-override"],
      ["CLAUDE.local.md", "L-claude-local"],
    ] as const) {
      writeFileSync(join(root, file), body, "utf8");
    }
    const rules = readCustomRules(root) ?? "";
    const idx = (marker: string) => rules.indexOf(marker);
    expect(idx("# AGENTS.md:")).toBeLessThan(idx("# CLAUDE.md:"));
    expect(idx("# CLAUDE.md:")).toBeLessThan(idx("# .acute/rules/a-rule.md:"));
    expect(idx("# .acute/rules/a-rule.md:")).toBeLessThan(idx("# .acute/rules/b-rule.md:")); // alphabetical
    expect(idx("# .acute/rules/b-rule.md:")).toBeLessThan(idx("# .acuterules:"));
    expect(idx("# .acuterules:")).toBeLessThan(idx("# AGENTS.override.md:"));
    expect(idx("# AGENTS.override.md:")).toBeLessThan(idx("# CLAUDE.local.md:"));
    for (const body of ["A-agents", "C-claude", "A-first-rule", "B-second-rule", "R-acute", "O-agents-override", "L-claude-local"]) {
      expect(rules).toContain(body);
    }
  });

  it("all files optional: a bare root loads nothing (undefined, the pre-D3 behavior)", () => {
    expect(readCustomRules(tempRoot())).toBeUndefined();
  });
});

describe("D3: @file imports (the AGENTS/CLAUDE bridge)", () => {
  it("a whole-line @docs/conventions.md import inlines the target with a `# <path>:` marker", () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "House rules.\n@docs/conventions.md\nThat is all.", "utf8");
    writeFileSync(join(root, "docs", "conventions.md"), "Conventions: tabs, not spaces.", "utf8");
    const rules = readCustomRules(root) ?? "";
    // The directive line is REPLACED by the inlined content.
    expect(rules).not.toContain("@docs/conventions.md");
    expect(rules).toContain("# docs/conventions.md:");
    expect(rules).toContain("Conventions: tabs, not spaces.");
    expect(rules).toContain("House rules.");
    expect(rules).toContain("That is all.");
    // R70 CI-stability pin: every `# <path>:` marker must use FORWARD slashes
    // only — Windows path.relative yields backslashes and the first R70 push
    // failed CI exactly here (run 34049175869); the marker contract is
    // OS-independent.
    for (const marker of rules.match(/^# .*:$/gm) ?? []) {
      expect(marker).not.toContain("\\");
    }
  });

  it("imports resolve relative to the INCLUDING file's dir, and nest one level", () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs", "deep"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "@docs/guide.md", "utf8");
    writeFileSync(join(root, "docs", "guide.md"), "Guide head.\n@deep/notes.md", "utf8");
    writeFileSync(join(root, "docs", "deep", "notes.md"), "Nested notes.", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("# docs/guide.md:");
    expect(rules).toContain("# docs/deep/notes.md:");
    expect(rules).toContain("Guide head.");
    expect(rules).toContain("Nested notes.");
  });

  it("CYCLES terminate: a ↔ b imports each inlined at most once", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "Root.\n@a.md", "utf8");
    writeFileSync(join(root, "a.md"), "A body.\n@b.md", "utf8");
    writeFileSync(join(root, "b.md"), "B body.\n@a.md", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("A body.");
    expect(rules).toContain("B body.");
    // a.md's content appears exactly once (the @a.md inside b.md is a
    // no-op — already visited), and b.md likewise.
    expect(rules.split("A body.").length).toBe(2); // 1 occurrence = 2 split parts
    expect(rules.split("B body.").length).toBe(2);
  });

  it("max 4 imported files TOTAL (breadth-first); the rest stay literal", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      ["@i1.md", "@i2.md", "@i3.md", "@i4.md", "@i5.md", "@i6.md"].join("\n"),
      "utf8",
    );
    for (let i = 1; i <= 6; i++) writeFileSync(join(root, `i${i}.md`), `import-${i}`, "utf8");
    const rules = readCustomRules(root) ?? "";
    for (let i = 1; i <= 4; i++) expect(rules).toContain(`import-${i}`); // first 4 inlined
    expect(rules).not.toContain("import-5"); // cap hit —
    expect(rules).not.toContain("import-6"); // — the rest are NOT inlined
    expect(rules).toContain("@i5.md"); // the literal directive line stays
  });

  it("only .md/.txt targets import; other extensions stay literal", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "@run.js\n@notes.txt", "utf8");
    writeFileSync(join(root, "run.js"), "console.log('nope')", "utf8");
    writeFileSync(join(root, "notes.txt"), "text notes import fine", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("@run.js"); // literal — wrong extension
    expect(rules).not.toContain("# run.js:");
    expect(rules).toContain("# notes.txt:"); // .txt imports
    expect(rules).toContain("text notes import fine");
  });

  it("an @-mention mid-sentence is NOT an import (whole-line directives only)", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "Ping @owner in reviews.\n@AGENTS.md", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("Ping @owner in reviews."); // untouched prose
  });

  it("`@AGENTS.md` inside CLAUDE.md is a DEDUPE (AGENTS.md is already loaded as its own part)", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "Shared agent rules.", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "Claude extras.\n@AGENTS.md", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("# AGENTS.md:");
    expect(rules).toContain("# CLAUDE.md:");
    expect(rules).toContain("Claude extras.");
    // The shared body appears ONCE (as the AGENTS.md part), not re-inlined
    // inside the CLAUDE.md part.
    expect(rules.split("Shared agent rules.").length).toBe(2);
  });

  it(".acuterules and .acute/rules files do NOT expand imports (raw text)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".acute", "rules"), { recursive: true });
    writeFileSync(join(root, ".acuterules"), "@notes.md", "utf8");
    writeFileSync(join(root, ".acute", "rules", "r.md"), "@notes.md", "utf8");
    writeFileSync(join(root, "notes.md"), "never inlined", "utf8");
    const rules = readCustomRules(root) ?? "";
    expect(rules).toContain("@notes.md"); // literal both times
    expect(rules).not.toContain("never inlined");
  });

  it("caps: 16K per file (imports count within the file's budget), 32K total", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), `${"a".repeat(20_000)}\n@big-import.md`, "utf8");
    writeFileSync(join(root, "big-import.md"), "IMPORTED-TAIL", "utf8");
    const rules = readCustomRules(root) ?? "";
    // The AGENTS.md part is capped at 16K — the import (counted within the
    // budget) never appears because the body ate it.
    expect(rules).not.toContain("IMPORTED-TAIL");
    expect(rules.length).toBeLessThanOrEqual(32_000 + 200); // + markers/joins

    // Total cap: two ~20K convention files → 32K total.
    const root2 = tempRoot();
    writeFileSync(join(root2, "AGENTS.md"), `${"a".repeat(20_000)}`, "utf8");
    writeFileSync(join(root2, "CLAUDE.md"), `${"b".repeat(20_000)}`, "utf8");
    expect((readCustomRules(root2) ?? "").length).toBeLessThanOrEqual(32_000 + 200);
  });

  it("the composed prompt narrates the convention hierarchy in the custom-rules section", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "Use pnpm.", "utf8");
    const composed = buildProjectSystemPrompt({
      ...ctxFor(),
      rootPath: root,
      customRules: readCustomRules(root),
    });
    const crIdx = composed.indexOf("## PROJECT RULES");
    const rest = composed.slice(crIdx, crIdx + 800);
    expect(rest).toContain("AGENTS.md, CLAUDE.md, .acute/rules/*.md, .acuterules, AGENTS.override.md, CLAUDE.local.md");
    expect(rest).toContain("later entries are MORE specific and authoritative");
    expect(rest).toContain("# AGENTS.md:");
    expect(rest).toContain("Use pnpm.");
  });
});

// ── D4: FILE EDITING UPGRADES ────────────────────────────────────────────────

describe("D4: the FILE EDITING rules", () => {
  it("the line-number-prefix rule (R70-a's read_file format meets edit anchors)", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed).toContain("**Line numbers are not content**");
    expect(composed).toContain("The prefix is NOT file content — edit_file oldString/newString anchors must be the RAW text of the line.");
  });

  it("prefer-editing + the full rule ladder", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed).toContain("**Prefer editing**");
    expect(composed).toContain("ALWAYS prefer editing an existing file over creating a new one — create new files only when genuinely required");
    expect(composed).toContain("**Smart verification**");
  });

  it("the dirty-worktree discipline is gated on git_status/run_command", () => {
    const full = buildProjectSystemPrompt(ctxFor());
    expect(full).toContain("**Dirty worktree discipline**");
    expect(full).toContain("NEVER revert or discard the user's changes");
    expect(full).toContain("NEVER run git reset --hard, git checkout --, or git clean");
    // ROUND-81: "editor" is retired — the pin's point was the TOOLSET gate
    // (no run_command AND no git_* → no discipline line), so the narrowed
    // toolNames carry it directly (permissionMode stays the "ask" default:
    // no permission-mode section, exactly the pre-editor composition).
    const noGitNoCmd = buildProjectSystemPrompt({
      ...ctxFor(),
      toolNames: TOOL_NAMES.filter((t) => t !== "run_command" && !t.startsWith("git_")),
    });
    expect(noGitNoCmd).not.toContain("**Dirty worktree discipline**");
    expect(noGitNoCmd).not.toContain("**Verify after edit**");
  });

  it("the verify-after-edit procedure is gated on run_command", () => {
    const full = buildProjectSystemPrompt(ctxFor());
    expect(full).toContain("**Verify after edit**");
    expect(full).toContain("run the project's checks before claiming done");
    expect(full).toContain("Discover the commands from the project's AGENTS.md / CLAUDE.md / package.json scripts");
    expect(full).toContain("memory_save the answer for this project");
    // Plan mode keeps neither → the rule is absent (honest dark-tools).
    const plan = buildProjectSystemPrompt({
      ...ctxFor(),
      toolNames: ["read_file", "list_dir", "search_code", "todo_write"],
      permissionMode: "plan",
    });
    expect(plan).not.toContain("**Verify after edit**");
  });
});

// ── D5: COMMUNICATION UPGRADES ───────────────────────────────────────────────

describe("D5: the COMMUNICATION contract", () => {
  it("verbosity + citations + the final-reply shape", () => {
    // R71-e1 re-pin: the final-reply contract UPGRADED from "VERIFICATION
    // evidence (which checks ran + their results)" to VERIFICATION RECEIPTS
    // (the exact command + exit status / key output line) — a stricter
    // version of the same R70-c shape, not a weakening.
    const composed = buildProjectSystemPrompt(ctxFor());
    const comm = buildSectionText(ctxFor(), "communication") ?? "";
    expect(comm).toContain("CONCISE BY DEFAULT");
    expect(comm).toContain("under ~4 lines unless the user asks for detail");
    expect(comm).toContain('Zero preamble ("I\'ll now…"), zero postamble ("Let me know if…")');
    expect(comm).toContain("Cite code locations as path:line (e.g. src/app.ts:42)");
    expect(comm).toContain(
      'state WHAT you did (the files touched), the VERIFICATION receipts (the exact command you ran + its exit status or key output line',
    );
    expect(comm).toContain("An assertion without a receipt is not verification.");
    // The formatting rules survive.
    expect(comm).toContain("Use **bold** for file names and `code` for identifiers");
    expect(composed).toContain("## COMMUNICATION");
  });
});

// ── D6: PANEL TRIMS + SKILLS RELOAD ──────────────────────────────────────────

describe("D6: browser-panel + computer-use trims", () => {
  it("browser-panel: materially smaller, vocabulary + discipline kept, craft pointer last", () => {
    const bp = buildSectionText(ctxFor(), "browser-panel") ?? "";
    expect(bp).toContain("## EMBEDDED BROWSER PANEL (browser_control)");
    // R94-G: 2,774 measured — the R94-F wait/sequence settle discipline
    // (~+570 gross) was paid for by absorbing the fresh-fetch advisory +
    // the viewport-announce line into the intro and tightening the action
    // parentheticals. Still ~32% below the pre-R70 4,056 the trim mandate
    // (R70-A issue #2) exists for.
    expect(bp.length).toBeLessThan(2_850);
    expect(bp.length).toBeGreaterThan(1_200); // the discipline survived
    // The kept contract pieces.
    expect(bp).toContain("read_dom first, then click / type the SELECTOR PATHS it returns");
    expect(bp).toContain("FORMS (R66): typing alone never submits");
    expect(bp).toContain("BOT WALLS (R66)");
    expect(bp).toContain("SURFACE BOUNDARY (R65)");
    for (const action of ["navigate", "read_dom", "set_viewport", "wait_for_verification", "get_state", "press_key", "screenshot", "eval"]) {
      expect(bp).toContain(action); // the vocabulary summary
    }
    // R94-G: the R94-F actions are in the vocabulary AND carry the settle
    // discipline — pinned as full phrases so a bare "wait" substring hit
    // from wait_for_verification cannot satisfy them.
    expect(bp).toContain("wait (settle until readyState/selector/urlContains)");
    expect(bp).toContain("sequence (a multi-step chain in ONE call");
    expect(bp).toContain("NAVIGATION SETTLES");
    expect(bp).toContain("verify the element you need EXISTS before interacting");
    // The craft pointer is the closing line.
    expect(bp.trimEnd().endsWith('Full browser craft (the core loop, forms, wait patterns, layout testing): read_skill "browser-use".')).toBe(true);
    // The retired deep-craft lines.
    expect(bp).not.toContain("TEST LAYOUTS");
    expect(bp).not.toContain("USE THE BROWSER LIKE A USER WOULD");
  });

  it("computer-use: smaller, R69 chain discipline + element-first + boundary kept, pointer last", () => {
    const cu = buildSectionText(ctxFor({ computerUse: { enabled: true, posture: "act" } }), "computer-use") ?? "";
    expect(cu).toContain("## COMPUTER USE (desktop control)");
    // R94-G: 3,389 measured — the R94-E window_action/windows_overview
    // discipline + the app_ref re-resolution half of the refusals rule
    // (~+430 gross) was paid for by tightening BIG APPS / TAB-WALK / the
    // intro. Still below the pre-R70 3,898 the trim mandate exists for.
    expect(cu.length).toBeLessThan(3_450);
    expect(cu.length).toBeGreaterThan(2_000); // the safety lines survived
    expect(cu).toContain("CHAIN DISCIPLINE (R69)");
    expect(cu).toContain("Do NOT screenshot or zoom after acting");
    expect(cu).toContain("Element-first beats coordinate guessing");
    expect(cu).toContain("SURFACE BOUNDARY (R65)");
    // R94-G: the window actor — exact identity targeting + window_action
    // as the one window-state tool + the app_ref re-resolution rule.
    expect(cu).toContain("identify windows by EXACT title/pid from list_apps / windows_overview");
    expect(cu).toContain("window_action (minimize/maximize/restore/focus/close; target:'foreground'");
    expect(cu).toContain("a dead app_ref → re-resolve it from list_apps");
    expect(cu).toContain("two identical failures = CHANGE STRATEGY");
    expect(cu.trimEnd().endsWith('read_skill "computer-use".')).toBe(true);
  });

  it("the observe posture line still composes", () => {
    const cu = buildSectionText(ctxFor({ computerUse: { enabled: true, posture: "observe" } }), "computer-use") ?? "";
    expect(cu).toContain("CURRENT POSTURE: OBSERVE-ONLY");
  });

  it("the SKILLS section teaches the reload affordance (no contradiction with the pointers)", () => {
    const skills = buildSectionText(
      ctxFor({ skills: [{ name: "browser-use", description: "Drive the embedded browser panel." }] }),
      "skills",
    ) ?? "";
    expect(skills).toContain("## SKILLS (load with read_skill)");
    expect(skills).toContain("**browser-use** — Drive the embedded browser panel.");
    expect(skills).toContain("A skill body that appears truncated after context compaction can be RELOADED: call read_skill again.");
  });
});
