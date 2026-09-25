/**
 * ROUND-113 (R113-f) — the PROMPT DISCIPLINE round (the owner's OMP-research
 * directive: "improve the overall project… the system prompts… take
 * references from OMP… and others… what the good system prompts look like…
 * how their skills are formatted so that we can format our skills properly
 * too"). Research-grounded (docs/planning/OMP-ADOPTION-ROADMAP.md + docs/
 * research/opencode/ + docs/research/agent-architectures-r96.md §2.5/§2.6 +
 * aider's strict-args lesson), verified against the CURRENT composition
 * before changing it (the mission's own rule), and surgical: every pinned
 * behavior of the r61/r65/r70/r71/r72/r73/r94/r96/r98 suites survives
 * untouched — this file pins only what R113-f ADDED or deliberately retired.
 *
 * Pins in this file:
 *   P1 — TOOL USE gains the ARGUMENT HYGIENE rule (arguments are copied from
 *        the tool outputs that issued them — never invented, never from
 *        memory; the R67 guessed-C:\-path and R94 stale-app_ref field
 *        reports were exactly this failure class). Unconditional: a bare
 *        read-only session still gets it.
 *   P2 — TERMINAL gains the BENIGN-EXIT rule (grep / test / diff exit 1 on
 *        no-match by design — Claude Code's documented "exit-1 is a benign
 *        result for grep/rg/find/diff/test"), tool-gated on run_command.
 *   P3 — the same-round DEDUP that pays for the additions: GIT's three
 *        "Use git_X to…" lines merged into one sequencing line ("Only
 *        commit when asked" verbatim), TERMINAL's "Prefer project-specific
 *        commands" retired (FILE EDITING rule 8 owns discovery), CODE
 *        NAVIGATION's list_dir line retired (the weakest survivor of every
 *        audit), MCP's "don't retry in a loop" tail retired (the RECOVERY
 *        PROTOCOL owns retry doctrine).
 *   P4 — the SIZE BUDGET holds WITHOUT a bump: the default full-tools
 *        composition stays ≤ 24,200 chars (r71 D6's bound, re-pinned by
 *        R117-c) and
 *        ≥ 23,000 (the additions are real content, not a gutting).
 *   P5 — the SKILLS ENVELOPE: read_skill's main-body output opens with
 *        "# Skill: <name>" + "> <description>" (the Agent-Skills shape —
 *        the description is always in context) for DB skills AND file
 *        skills; a house-format "# Skill: <name>" first line in the body is
 *        DEDUPED (one identity header, not two); any other body rides
 *        verbatim; the R72-c references listing still rides after the body.
 *   P6 — THREE-SURFACE COHERENCE: the same description string reaches the
 *        model on all three skills surfaces — the prompt's SKILLS index
 *        line, the search_skills result, and the read_skill body envelope.
 *
 * No live calls: everything runs against temp DBs + temp project roots.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createSkill, seedBuiltinSkills } from "../src/storage/skills";
import { skillsPlugin } from "../src/tools/plugins/skills";
import type { ToolDefinition } from "../src/tools/registry";
import type { ToolDeps } from "../src/tools/index";
import {
  buildProjectSystemPrompt,
  buildSectionText,
  type PromptContext,
  type PromptEnvironment,
} from "../src/agents/prompts";
import { TOOL_NAMES } from "../src/storage/agents";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r113f-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── the prompt-side harness (hermetic — no db, no override files) ────────── */

const BASE_ENV: PromptEnvironment = {
  osPlatform: "Linux",
  osRelease: "6.5.0-r113f",
  shell: "/bin/sh",
  currentDate: "2026-06-11 (Thursday)",
  gitBranch: "main",
  gitDirty: false,
};

/** The default full-tools ctx (r71 D6's own shape — the budget is compared
 * on the SAME composition that test measures). */
function ctxFor(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "R113fProject",
    rootPath: join(tempDir, "never-exists"),
    toolNames: [...TOOL_NAMES],
    maxTurns: 40,
    maxOuterLoops: 5,
    environment: { ...BASE_ENV },
    ...overrides,
  };
}

/* ── the skills-side harness (temp db + temp project root) ───────────────── */

/** The plugin's two tools built for the shared db (r96-d's buildTools shape). */
function buildTools(root: string): ToolDefinition[] {
  const toolDeps = { db, sessionId: "sess_r113f" } as ToolDeps;
  const tools = skillsPlugin.createTools({ root, toolDeps }) as ToolDefinition[];
  expect(tools.map((t) => t.name)).toEqual(["read_skill", "search_skills"]);
  return tools;
}

type Exec = (input: Record<string, unknown>) => { ok: boolean; output: string };

/** read_skill's execute, typed for the tests below. */
function readSkill(root: string): Exec {
  const tool = buildTools(root)[0]!;
  return (input) => tool.execute(input, { root }) as { ok: boolean; output: string };
}

/** search_skills' execute, typed for the tests below. */
function searchSkills(root: string): Exec {
  const tool = buildTools(root)[1]!;
  return (input) => tool.execute(input, { root }) as { ok: boolean; output: string };
}

/** A project root with .acute/skills/<name>/SKILL.md created on demand. */
function projectRootWith(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tempDir, "proj-"));
  for (const [name, content] of Object.entries(skills)) {
    const dir = join(root, ".acute", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — TOOL USE: the argument-hygiene rule
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P1: TOOL USE gains the ARGUMENT HYGIENE rule", () => {
  it("the rule composes in the TOOL USE rules block, right after MOST SPECIFIC", () => {
    const section = buildSectionText(ctxFor(), "tool-use") ?? "";
    expect(section).toContain("- **Arguments come from observed data:**");
    expect(section).toContain("never invent a value, never trust memory of an earlier output (ids expire, files move)");
    expect(section).toContain("A guessed argument is a wasted call.");
    // Position: the rule names WHICH value goes into the tool the most-specific
    // line picked — it rides directly after that line.
    const idx = (needle: string) => section.indexOf(needle);
    expect(idx("Pick the most specific tool for the job")).toBeGreaterThan(-1);
    expect(idx("- **Arguments come from observed data:**")).toBeGreaterThan(idx("Pick the most specific tool for the job"));
    expect(idx("- NEVER fabricate or embellish a tool result")).toBeGreaterThan(
      idx("- **Arguments come from observed data:**"),
    );
  });

  it("unconditional: a bare read-only session still gets the rule (no tool gate)", () => {
    const bare = buildProjectSystemPrompt({
      projectName: "Bare",
      rootPath: join(tempDir, "never-exists"),
      toolNames: ["read_file", "search_code"],
    });
    expect(bare).toContain("- **Arguments come from observed data:**");
  });

  it("composes with the honesty doctrine it extends (READ errors + never fabricate stay intact)", () => {
    const section = buildSectionText(ctxFor(), "tool-use") ?? "";
    expect(section).toContain("**Read tool errors fully before reacting:**");
    expect(section).toContain("NEVER fabricate or embellish a tool result");
    expect(section).toContain("A failed, timed-out, or partial call is the data");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — TERMINAL: the benign-exit rule
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P2: TERMINAL gains the benign-exit rule", () => {
  it("the rule composes in the TERMINAL section (grep/test/diff exit 1 on no-match)", () => {
    const section = buildSectionText(ctxFor(), "terminal") ?? "";
    expect(section).toContain("- A non-zero exit is often the answer, not a failure:");
    expect(section).toContain("grep / test / diff exit 1 on no-match by design");
    expect(section).toContain("read the output before deciding anything failed");
    // Position: directly under the section's role line.
    expect(section.indexOf("- A non-zero exit")).toBeGreaterThan(section.indexOf("- Use run_command for builds"));
  });

  it("tool-gated honestly: no run_command in the vocabulary → no benign-exit line", () => {
    const noCmd = buildProjectSystemPrompt({
      ...ctxFor(),
      toolNames: ctxFor().toolNames.filter((t) => t !== "run_command"),
    });
    expect(noCmd).not.toContain("A non-zero exit is often the answer");
    expect(noCmd).not.toContain("## TERMINAL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 — the same-round dedup (the retirements that fund the additions)
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P3: the dedup retirements", () => {
  it("GIT: the three 'Use git_X to…' lines are ONE sequencing line; 'Only commit when asked' survives verbatim", () => {
    const section = buildSectionText(ctxFor(), "git") ?? "";
    expect(section).toContain("- git_status before making changes; git_diff before committing; git_log when investigating history.");
    expect(section).toContain("- Only commit when the user explicitly asks.");
    // The retired verbose forms are gone.
    expect(section).not.toContain("Use git_status before making changes to understand");
    expect(section).not.toContain("Use git_diff to review changes before committing.");
    expect(section).not.toContain("Use git_log to understand recent history");
  });

  it("TERMINAL: 'Prefer project-specific commands' retired (FILE EDITING rule 8 owns discovery)", () => {
    const section = buildSectionText(ctxFor(), "terminal") ?? "";
    expect(section).not.toContain("Prefer project-specific commands");
    // The owning rule survives elsewhere.
    const editing = buildSectionText(ctxFor(), "file-editing") ?? "";
    expect(editing).toContain("Discover the commands from the project's AGENTS.md / CLAUDE.md / package.json scripts");
  });

  it("CODE NAVIGATION: the list_dir line retired; search_symbols + ALWAYS-search survive", () => {
    const section = buildSectionText(ctxFor(), "code-navigation") ?? "";
    expect(section).not.toContain("Use list_dir to explore folder structure");
    expect(section).toContain("try it before search_code when hunting a definition");
    expect(section).toContain("- ALWAYS search before assuming a file exists or doesn't exist.");
  });

  it("MCP: the 'don't retry in a loop' tail retired (RECOVERY owns retry doctrine)", () => {
    const composed = buildProjectSystemPrompt({ ...ctxFor(), toolNames: [...TOOL_NAMES, "mcp__demo__echo"] });
    expect(composed).toContain("report the error honestly.");
    expect(composed).not.toContain("don't retry in a loop");
    // The owning doctrine survives.
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("**Identical retries:** at most 2.");
    expect(recovery).toContain("never retry blind");
  });

  it("WEB ACCESS: the search-first line compressed; the cite contract survives", () => {
    const section = buildSectionText(ctxFor(), "web-access") ?? "";
    expect(section).toContain("- When you don't know the exact URL: web_search first, then web_fetch the most relevant hit");
    expect(section).toContain("cite the URL you fetched so the user can verify");
    expect(section).not.toContain("Always web_search first when you don't know the exact URL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — the size budget holds WITHOUT a bump
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P4: the 24,000 budget holds without a bump", () => {
  it("the DEFAULT full-tools composition stays ≤ 24,900 and ≥ 23,000 chars", () => {
    // r71 D6's bound, re-pinned by R117-c (the prompt-engineering pass):
    // the calibrated spellings + the <project_memory>/<todo_list>/
    // <background_tasks> fences grew the composition ~+216 net over the
    // R113-f measured 23,871 (23,765 at R107-a) — measured 24,087 after
    // the rework. Re-pinned again by R117-d (the robust-orchestration
    // round): the SUB-AGENTS section gained ONE line (the delegation
    // machine-readable block's scope-decisions teaching) — measured
    // 24,206. Re-pinned again by R127-W6 (the agent-smarter round): the
    // EXPLORE arithmetic + dependent-set wait rule, the BATCH DISCIPLINE
    // bullet's same additions, and the read_file descriptions line's
    // ~128KB whole-file clause — measured 24,804 (mirrors r71 D6's
    // 25,000 recalibration). The floor keeps the retirements honest —
    // the additions survived as content.
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed.length).toBeLessThanOrEqual(24_900); // R127-W6: the agent-smarter additions measured 24,804
    expect(composed.length).toBeGreaterThanOrEqual(23_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5 — the SKILLS ENVELOPE (read_skill's main-body output)
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P5: read_skill renders the Agent-Skills envelope", () => {
  it("a DB skill: '# Skill: <name>' + '> <description>' + blank + body; ONE identity header (the house first line is deduped)", () => {
    seedBuiltinSkills(db);
    const root = join(tempDir, "proj-empty");
    const result = readSkill(root)({ name: "debugging" });
    expect(result.ok).toBe(true);
    // The envelope: identity line, description blockquote, separator, body.
    expect(result.output.startsWith("# Skill: debugging\n> ")).toBe(true);
    expect(result.output).toContain("Use when the user reports a defect");
    // The builtin body's own house header ("# Skill: debugging") is DEDUPED
    // — exactly one identity header, and the body's real first line follows.
    expect(result.output.match(/^# Skill: debugging$/gm)?.length).toBe(1);
    expect(result.output).toContain("Fix the cause, never the symptom.");
    // Envelope → body separator shape.
    expect(result.output).toMatch(/^# Skill: debugging\n> .+\n\nFix the cause/m);
  });

  it("a USER DB skill whose body carries NO house header rides verbatim under the envelope", () => {
    const created = createSkill(db, {
      name: "custom-flow",
      description: "Use when the user says 'run the custom flow'.",
      body: "Step one. Step two.",
    });
    expect(created.name).toBe("custom-flow");
    const root = join(tempDir, "proj-empty");
    const result = readSkill(root)({ name: "custom-flow" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("# Skill: custom-flow\n> Use when the user says 'run the custom flow'.\n\nStep one. Step two.");
  });

  it("a FILE skill: the same envelope over the disk-read body (frontmatter stripped)", () => {
    const root = projectRootWith({
      "deploy-flow":
        "---\nname: deploy-flow\ndescription: How this project ships.\n---\n# Deploy flow\n\n1. Run the tests.\n2. Tag the release.",
    });
    const result = readSkill(root)({ name: "deploy-flow" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      "# Skill: deploy-flow\n> How this project ships.\n\n# Deploy flow\n\n1. Run the tests.\n2. Tag the release.",
    );
    // The frontmatter itself never leaks.
    expect(result.output).not.toContain("description: How this project ships");
  });

  it("a body whose first line is a DIFFERENT skill's header rides verbatim (exact-match dedup only)", () => {
    const root = projectRootWith({
      "odd-skill": "---\ndescription: An odd one.\n---\n# Skill: something-else\n\nBody.",
    });
    const result = readSkill(root)({ name: "odd-skill" });
    expect(result.ok).toBe(true);
    // Not this skill's house header → body content, rides verbatim.
    expect(result.output).toBe("# Skill: odd-skill\n> An odd one.\n\n# Skill: something-else\n\nBody.");
  });

  it("a body that is ONLY the house header degrades to the envelope + empty body honestly", () => {
    const created = createSkill(db, {
      name: "header-only",
      description: "Use when testing the degenerate case.",
      body: "# Skill: header-only",
    });
    expect(created.name).toBe("header-only");
    const root = join(tempDir, "proj-empty");
    const result = readSkill(root)({ name: "header-only" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("# Skill: header-only\n> Use when testing the degenerate case.\n\n");
  });

  it("the R72-c references listing still rides AFTER the body (the envelope did not displace it)", () => {
    const root = mkdtempSync(join(tempDir, "proj-refs-"));
    const dir = join(root, ".acute", "skills", "with-refs");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Has references.\n---\nBody here.", "utf8");
    writeFileSync(join(dir, "references", "deep.md"), "# Deep reference\n\nDetail.", "utf8");
    const result = readSkill(root)({ name: "with-refs" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Skill: with-refs\n> Has references.\n\nBody here.");
    expect(result.output).toContain('references available: deep — load with read_skill { name: "with-refs", reference: "deep" }');
    // The listing rides at the END (after the body), unchanged by the envelope.
    expect(result.output.indexOf("references available:")).toBeGreaterThan(result.output.indexOf("Body here."));
  });

  it("reference LOADS keep their own header shape (the envelope belongs to the SKILL, not each reference)", () => {
    const root = mkdtempSync(join(tempDir, "proj-refload-"));
    const dir = join(root, ".acute", "skills", "with-refs");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Has references.\n---\nBody here.", "utf8");
    writeFileSync(join(dir, "references", "deep.md"), "# Deep reference\n\nDetail.", "utf8");
    const result = readSkill(root)({ name: "with-refs", reference: "deep" });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("# Skill: with-refs — reference: deep\n\n")).toBe(true);
    expect(result.output).toContain("# Deep reference");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P6 — three-surface coherence: ONE description, all three surfaces
// ─────────────────────────────────────────────────────────────────────────────

describe("R113-f P6: the description reaches all three skills surfaces", () => {
  it("the prompt SKILLS index, the search_skills result, and the read_skill envelope carry the SAME description", () => {
    seedBuiltinSkills(db);
    const root = join(tempDir, "proj-coherence");

    // Surface 1 — the prompt's SKILLS index line.
    const ctx = ctxFor({
      rootPath: root,
      skills: [{ name: "debugging", description: "Use when the user reports a defect — a defect hunt." }],
    });
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("- **debugging** — Use when the user reports a defect — a defect hunt.");

    // Surface 2 — the search_skills result.
    const search = searchSkills(root)({ query: "defect" });
    expect(search.ok).toBe(true);
    expect(search.output).toContain("- **debugging** — ");
    expect(search.output).toContain("Use when the user reports a defect");

    // Surface 3 — the read_skill body envelope (the R113-f addition).
    const load = readSkill(root)({ name: "debugging" });
    expect(load.ok).toBe(true);
    expect(load.output).toContain("\n> Use when the user reports a defect");
  });
});
