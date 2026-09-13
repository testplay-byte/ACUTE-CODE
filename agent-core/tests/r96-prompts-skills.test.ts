/**
 * ROUND-96 (R96-D) — the PROMPTS + SKILLS round:
 *
 *   The owner's directives, verbatim:
 *     · "There should be proper skills for this: a planning skill, a UI
 *       skill, an error-testing skill, various other kinds of skills which
 *       it can utilize whenever it feels like. All of these skills will
 *       not be sent into the prompt by default but the agent can request
 *       which skills it wants to use… It can search for the skills too if
 *       it needs to."
 *     · "If the user, for example, in an HTML file tells it to change a
 *       specific text from this to this, then it will not try to analyze
 *       the whole HTML… It will run multiple commands in a single go…
 *       batch commands."
 *     · "Make our agent much smarter and much more capable… like modern
 *       agentic coding IDEs."
 *
 * Pins in this file:
 *   P1 — the three new prompt sections compose IN ORDER (BATCH + COMPLETION
 *        behind the agentic loop, PRECISION behind code navigation) with
 *        their content contracts (owner-quote-derived lines); the loop's
 *        VERIFY phase gained on-disk verification and FINISH names the
 *        "Task complete." line (the phrase runtime's COMPLETION_SIGNAL
 *        recognizes).
 *   P2 — the SKILLS section is BUDGETED: the default 24-builtin family
 *        lists INTACT (the caps engage only for extra skills — measured
 *        ~11.2K < the 12K char budget), and synthetic overflow trips BOTH
 *        caps with the honest "…and M more — search_skills to discover
 *        them" note; the header names BOTH read_skill and search_skills.
 *   P3 — the four new seeded skills (planning, ui-design, error-testing,
 *        large-project-navigation): fixed ids, sortOrder 20-23, enabled,
 *        trigger-rich descriptions, 40-120-line WHEN TO USE / PROCEDURE /
 *        ANTI-PATTERNS bodies with content pins, INSERT OR IGNORE contract.
 *   P4 — the search_skills tool: keyword matches over names +
 *        descriptions + reference titles, deterministic ranking (exact
 *        name > prefix > word > substring > description > reference), the
 *        8-result cap with its overflow note, the honest no-match, and the
 *        SAME gating read_skill applies (disabled rows, the computer-use
 *        master switch, the agent allowlist) — search never advertises
 *        what read_skill would refuse.
 *
 * No live calls: everything runs against temp DBs + temp project roots.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { getSkill, listSkills, seedBuiltinSkills, updateSkill } from "../src/storage/skills";
import { setComputerUseSettings } from "../src/storage/computer-use";
import { createAgent } from "../src/storage/agents";
import { skillsPlugin } from "../src/tools/plugins/skills";
import type { ToolDefinition } from "../src/tools/registry";
import type { ToolDeps } from "../src/tools/index";
import {
  buildProjectSystemPrompt,
  buildSectionText,
  SKILLS_LISTED_MAX,
  SKILLS_SECTION_CHAR_BUDGET,
  type PromptContext,
} from "../src/agents/prompts";
import { PROMPT_SECTION_IDS } from "../src/agents/prompt-registry";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r96d-"));
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

/** A prompt ctx that never reads override files (fresh temp root). */
function promptCtx(skills: ReadonlyArray<{ name: string; description: string }>): PromptContext {
  return {
    projectName: "R96dProject",
    rootPath: join(tempDir, "never-exists"),
    toolNames: ["read_file", "search_files", "search_code", "edit_file", "run_command", "todo_write", "browser_control"],
    maxTurns: 40,
    maxOuterLoops: 5,
    skills,
  };
}

/** The tools of the skills plugin built for the shared db + optional agent. */
function buildTools(root: string, agentId?: string): ToolDefinition[] {
  const toolDeps = { db, sessionId: "sess_r96d", ...(agentId !== undefined ? { agentId } : {}) } as ToolDeps;
  return skillsPlugin.createTools({ root, toolDeps }) as ToolDefinition[];
}

/** The search_skills tool (index 1 — read_skill is 0). */
function searchTool(root: string, agentId?: string): ToolDefinition {
  const tools = buildTools(root, agentId);
  expect(tools.map((t) => t.name)).toEqual(["read_skill", "search_skills"]);
  return tools[1]!;
}

/** A project root with .acute/skills/<name>/SKILL.md + optional references/. */
function projectRootWith(
  skills: Record<string, { skill: string; references?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tempDir, "proj-"));
  for (const [name, def] of Object.entries(skills)) {
    const dir = join(root, ".acute", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), def.skill, "utf8");
    if (def.references !== undefined) {
      const refDir = join(dir, "references");
      mkdirSync(refDir, { recursive: true });
      for (const [fileName, content] of Object.entries(def.references)) {
        writeFileSync(join(refDir, fileName), content, "utf8");
      }
    }
  }
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — the three new prompt sections: order + content contracts
// ─────────────────────────────────────────────────────────────────────────────

describe("R96-D P1: the new prompt sections compose in order", () => {
  const composed = (): string => buildProjectSystemPrompt(promptCtx([]));
  // The GIT section is conditional on the git tools riding the turn — the
  // ordering pin needs a ctx that carries them (promptCtx's default is the
  // minimal read/edit set).
  const composedWithGit = (): string =>
    buildProjectSystemPrompt({ ...promptCtx([]), toolNames: [...promptCtx([]).toolNames, "git_status", "git_diff", "git_log"] });

  it("the registry carries the three new ids in the designed slots", () => {
    expect(PROMPT_SECTION_IDS).toContain("batch-discipline");
    expect(PROMPT_SECTION_IDS).toContain("completion-discipline");
    expect(PROMPT_SECTION_IDS).toContain("precision-discipline");
    expect(PROMPT_SECTION_IDS.indexOf("batch-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("agentic-loop") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("completion-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("batch-discipline") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("recovery")).toBe(PROMPT_SECTION_IDS.indexOf("completion-discipline") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("precision-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("code-navigation") + 1);
  });

  it("BATCH DISCIPLINE sits between the AGENTIC LOOP and the RECOVERY PROTOCOL (headings in order)", () => {
    const text = composed();
    const loop = text.indexOf("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    const batch = text.indexOf("## BATCH DISCIPLINE");
    const completion = text.indexOf("## COMPLETION DISCIPLINE");
    const recovery = text.indexOf("## RECOVERY PROTOCOL (tool failures)");
    const engineering = text.indexOf("## ENGINEERING DISCIPLINE");
    expect(loop).toBeGreaterThan(-1);
    expect(batch).toBeGreaterThan(loop);
    expect(completion).toBeGreaterThan(batch);
    expect(recovery).toBeGreaterThan(completion);
    expect(engineering).toBeGreaterThan(recovery);
  });

  it("PRECISION DISCIPLINE sits between CODE NAVIGATION and GIT (headings in order)", () => {
    const text = composedWithGit();
    const nav = text.indexOf("## CODE NAVIGATION");
    const precision = text.indexOf("## PRECISION DISCIPLINE (target before you read)");
    const git = text.indexOf("## GIT");
    expect(nav).toBeGreaterThan(-1);
    expect(precision).toBeGreaterThan(nav);
    expect(git).toBeGreaterThan(precision);
  });

  it("BATCH DISCIPLINE teaches the owner's batching directive (content pins)", () => {
    const text = composed();
    // The owner: "It will run multiple commands in a single go… batch commands."
    expect(text).toContain("issue them ALL in ONE response");
    expect(text).toContain("DEPENDENT CALLS WAIT");
    expect(text).toContain("CHAIN SHELL COMMANDS");
    expect(text).toContain("`a && b`");
    expect(text).toContain("ONE-CALL-ONE-WAIT IS THE ANTI-PATTERN");
  });

  it("COMPLETION DISCIPLINE teaches the explicit ending contract", () => {
    const text = composed();
    // The exact phrase runtime's COMPLETION_SIGNAL regex recognizes.
    expect(text).toContain("END WITH THE LINE: Task complete.");
    expect(text).toContain("NEVER pad finished work");
    expect(text).toContain("NEVER restart finished work");
  });

  it("PRECISION DISCIPLINE teaches the owner's HTML example (content pins)", () => {
    const text = composed();
    // The owner: "…in an HTML file tells it to change a specific text from
    // this to this, then it will not try to analyze the whole HTML."
    expect(text).toContain("TARGET THE FILE FIRST");
    expect(text).toContain("READ ONLY WHAT THE TASK NEEDS");
    expect(text).toContain("EDITS USE EXACT ANCHORS from the CURRENT content");
    expect(text).toContain("one character off is a miss");
    expect(text).toContain('"CHANGE X TO Y IN FILE F"');
    expect(text).toContain("NEVER analyze the whole project (or a whole HTML file) when one file and one string are named");
  });

  it("the loop's VERIFY phase gained on-disk verification; FINISH names the completion line", () => {
    const text = composed();
    expect(text).toContain("verify the change ON DISK before claiming done");
    expect(text).toContain("for VISUAL changes, screenshot via the browser tools and look at the result");
    expect(text).toContain('end with the explicit completion line: Task complete. (see COMPLETION DISCIPLINE below)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — the BUDGETED SKILLS listing
// ─────────────────────────────────────────────────────────────────────────────

describe("R96-D P2: the SKILLS section budget", () => {
  it("the header names BOTH tools and the intro points at search_skills", () => {
    const section = buildSectionText(promptCtx([{ name: "demo", description: "A demo skill." }]), "skills") ?? "";
    expect(section).toContain("## SKILLS (load with read_skill, search with search_skills)");
    expect(section).toContain("call read_skill with its name FIRST");
    expect(section).toContain("call search_skills with a keyword");
    // No overflow on a small set — the note must NOT render.
    expect(section).not.toContain("search_skills to discover them");
    expect(section).toContain("- **demo** — A demo skill.");
  });

  it("the DEFAULT 24-builtin family lists INTACT (the caps engage only for extra skills)", () => {
    // The measured rationale: the seeded core lists at ~11.2K chars — under
    // the 12K budget BY DESIGN (the task's suggested ~8K would have cut
    // spec-planning/performance out of every fresh install).
    const builtins = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => ({ name: s.name, description: s.description }));
    expect(builtins).toHaveLength(24);

    const section = buildSectionText(promptCtx(builtins), "skills") ?? "";
    for (const skill of builtins) {
      expect(section).toContain(`- **${skill.name}** — ${skill.description}`);
    }
    expect(section).not.toContain("search_skills to discover them");
    // Prompt-token sanity: the whole listing stays inside the budget.
    const listingChars = section
      .split("\n")
      .filter((l) => l.startsWith("- **"))
      .reduce((sum, l) => sum + l.length + 1, 0);
    expect(listingChars).toBeLessThanOrEqual(SKILLS_SECTION_CHAR_BUDGET);
    expect(listingChars).toBeGreaterThan(9_000); // substantial, not silently trimmed
  });

  it("the COUNT cap: 40 skills → SKILLS_LISTED_MAX listed + the honest overflow note", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-number-${String(i).padStart(2, "0")}`,
      description: `Synthetic skill ${i} for the budget pin.`,
    }));
    const section = buildSectionText(promptCtx(many), "skills") ?? "";
    const listed = section.split("\n").filter((l) => l.startsWith("- **"));
    expect(listed).toHaveLength(SKILLS_LISTED_MAX);
    // The HEAD survives (stable order — first in, first listed) and the
    // tail drops with the honest note.
    expect(section).toContain("- **skill-number-00** — Synthetic skill 0 for the budget pin.");
    expect(section).not.toContain("- **skill-number-39** —");
    expect(section).toContain(`- …and ${40 - SKILLS_LISTED_MAX} more — search_skills to discover them`);
  });

  it("the CHAR cap: fat descriptions trip the budget before the count cap", () => {
    // 24 skills × ~600-char descriptions ≈ 14.4K > 12K: the char budget
    // cuts the tail even though the count (24) is under SKILLS_LISTED_MAX.
    const fat = Array.from({ length: 24 }, (_, i) => ({
      name: `fat-skill-${String(i).padStart(2, "0")}`,
      description: `A deliberately long description. ${"x".repeat(560)}`,
    }));
    const section = buildSectionText(promptCtx(fat), "skills") ?? "";
    const listed = section.split("\n").filter((l) => l.startsWith("- **"));
    expect(listed.length).toBeLessThan(24);
    expect(listed.length).toBeGreaterThan(0);
    expect(section).toContain("- **fat-skill-00** —");
    expect(section).not.toContain("- **fat-skill-23** —");
    expect(section).toMatch(/- …and \d+ more — search_skills to discover them/);
  });

  it("the FIRST skill always lists (degenerate guard: one line over budget still renders)", () => {
    const huge = [{ name: "huge-skill", description: "y".repeat(4_000) }];
    const section = buildSectionText(promptCtx(huge), "skills") ?? "";
    expect(section).toContain("- **huge-skill** — ");
    expect(section).not.toContain("search_skills to discover them");
  });

  it("task hints still render AFTER the capped list (the advisory survives the budget)", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-number-${String(i).padStart(2, "0")}`,
      description: `Synthetic skill ${i} for the budget pin.`,
    }));
    const section = buildSectionText(
      { ...promptCtx(many), taskHints: [{ skillName: "skill-number-39", score: 9 }] },
      "skills",
    ) ?? "";
    expect(section).toContain(`- …and ${40 - SKILLS_LISTED_MAX} more — search_skills to discover them`);
    // The hint may name a skill the listing cut — read_skill still resolves
    // the FULL index; the hint's read_skill call keeps working.
    expect(section).toContain("Task signal: this request looks like it matches **skill-number-39**");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 — the four new seeded skills
// ─────────────────────────────────────────────────────────────────────────────

describe("R96-D P3: the four owner-named builtins seed", () => {
  const R96D_BUILTINS: ReadonlyArray<{ name: string; id: string; sortOrder: number; trigger: string }> = [
    { name: "planning", id: "skill_builtin_planning", sortOrder: 20, trigger: "'work through this list'" },
    { name: "ui-design", id: "skill_builtin_ui_design", sortOrder: 21, trigger: "'this looks off'" },
    { name: "error-testing", id: "skill_builtin_error_testing", sortOrder: 22, trigger: "'it worked yesterday'" },
    { name: "large-project-navigation", id: "skill_builtin_large_project_navigation", sortOrder: 23, trigger: "'where is X implemented'" },
  ];

  it("each seeds with its fixed id, sortOrder 20-23, enabled, house-shaped description", () => {
    const byName = new Map(listSkills(db).filter((s) => s.source === "builtin").map((s) => [s.name, s]));
    expect([...byName.keys()]).toHaveLength(24);
    for (const expected of R96D_BUILTINS) {
      const skill = byName.get(expected.name);
      expect(skill).toBeDefined();
      expect(skill?.id).toBe(expected.id);
      expect(skill?.sortOrder).toBe(expected.sortOrder);
      expect(skill?.enabled).toBe(true);
      const description = skill?.description ?? "";
      expect(description).toMatch(/use when /i);
      expect(description).toMatch(/delivers /i);
      expect(description).toMatch(/not for /i);
      expect(description).toContain(expected.trigger);
      expect(description.length).toBeLessThanOrEqual(500);
      expect(description.length).toBeGreaterThan(160);
    }
  });

  it.each(R96D_BUILTINS)(
    "%s: '# Skill:' prefix, 40-120 lines, >= 1.8KB, no emoji, the WHEN/PROCEDURE/ANTI structure",
    (expected) => {
      const body = getSkill(db, expected.id)?.body ?? "";
      expect(body.startsWith(`# Skill: ${expected.name}`)).toBe(true);
      // The R96-D task spec's format band — deliberately above the R72
      // 1.2-1.9KB house band (the owner asked for capability).
      expect(body.trim().split("\n").length).toBeGreaterThanOrEqual(40);
      expect(body.trim().split("\n").length).toBeLessThanOrEqual(120);
      expect(body.length).toBeGreaterThanOrEqual(1_800);
      expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(body).toMatch(/## When to use/);
      expect(body).toMatch(/## Procedure/);
      expect(body).toMatch(/## Anti-patterns/);
    },
  );

  it("planning: the REAL planning contract (decompose + todo_write + re-plan)", () => {
    const body = getSkill(db, "skill_builtin_planning")?.body ?? "";
    expect(body).toContain("IRON LAW");
    expect(body).toContain("todo_write");
    expect(body).toContain("verifiable");
    expect(body).toContain("RE-PLAN ON SURPRISE");
    expect(body).toContain("When NOT to plan");
  });

  it("ui-design: mirrors the app's OWN design docs + screenshot verification", () => {
    const body = getSkill(db, "skill_builtin_ui_design")?.body ?? "";
    expect(body).toContain("docs/design/ui-direction.md");
    expect(body).toContain("docs/design/DESIGN-SYSTEM.md");
    expect(body).toContain("SCREENSHOT-VERIFY");
    expect(body).toContain("browser_control screenshot");
    expect(body).toContain("set_viewport");
    expect(body).toContain("theme");
  });

  it("error-testing: reproduce → read the REAL error → one hypothesis → targeted test", () => {
    const body = getSkill(db, "skill_builtin_error_testing")?.body ?? "";
    expect(body).toContain("REPRODUCE FIRST");
    expect(body).toContain("READ THE REAL ERROR");
    expect(body).toContain("ONE HYPOTHESIS AT A TIME");
    expect(body).toContain("VERIFY WITH A TARGETED TEST");
    expect(body).toContain("regression");
  });

  it("large-project-navigation: search-first orientation + context budgeting", () => {
    const body = getSkill(db, "skill_builtin_large_project_navigation")?.body ?? "";
    expect(body).toContain("ORIENT BY SEARCH, NOT BY LISTING");
    expect(body).toContain("search_files");
    expect(body).toContain("search_code");
    expect(body).toContain("index_project");
    expect(body).toContain("NEVER re-read what is already in your context");
    expect(body).toContain("todo_write");
  });

  it("INSERT OR IGNORE: idempotent re-seed, and a deleted R96-D row revives on reopen", () => {
    seedBuiltinSkills(db);
    seedBuiltinSkills(db);
    expect(listSkills(db).filter((s) => s.source === "builtin")).toHaveLength(24);

    db.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_planning");
    const reopened = openDatabase(join(tempDir, "reopen.db"));
    try {
      const revived = getSkill(reopened, "skill_builtin_planning");
      expect(revived?.name).toBe("planning");
      expect(revived?.body).toContain("RE-PLAN ON SURPRISE");
      expect(listSkills(reopened).filter((s) => s.source === "builtin")).toHaveLength(24);
    } finally {
      reopened.close();
    }
  });

  it("user edits to the new builtins persist across reseeds (the standing contract)", () => {
    updateSkill(db, "skill_builtin_planning", { body: "MY PLANNING EDIT" });
    seedBuiltinSkills(db);
    expect(getSkill(db, "skill_builtin_planning")?.body).toBe("MY PLANNING EDIT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — the search_skills tool
// ─────────────────────────────────────────────────────────────────────────────

describe("R96-D P4: search_skills (the discovery tool)", () => {
  const root = (): string => join(tempDir, `never-exists-${randomUUID()}`);

  it("an empty query is refused honestly (mirrors read_skill's name-required)", () => {
    const tool = searchTool(root());
    const result = tool.execute({ query: "   " }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(false);
    expect(result.output).toContain("search_skills: query is required");
  });

  it("matches by NAME with deterministic ranking: exact > word > description-only", () => {
    const tool = searchTool(root());
    const result = tool.execute({ query: "planning" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n").filter((l) => l.startsWith("- **"));
    // Exact name match ranks first; the hyphen-word match (spec-planning)
    // and description matches follow, never ahead of it.
    expect(lines[0]).toContain("**planning** —");
    expect(result.output).toContain("**spec-planning**");
    expect(result.output).toContain("load with read_skill { name: \"planning\" }");
    expect(result.output).toMatch(/of \d+ skills \(best first\)/);
  });

  it("matches by DESCRIPTION keyword (a craft the name does not carry)", () => {
    const tool = searchTool(root());
    const result = tool.execute({ query: "screenshot" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    expect(result.output).toContain("**ui-design**");
  });

  it("matches by REFERENCE TITLE (file-based skills' references/)", () => {
    const proj = projectRootWith({
      "deploy-flow": {
        skill: `---
name: deploy-flow
description: Ship the deploy flow.
---
Body of the deploy-flow skill.`,
        references: {
          "rollback.md": "The rollback procedure lives here.",
          "ci-checklist.md": "The CI checklist.",
        },
      },
    });
    const tool = searchTool(proj);
    const result = tool.execute({ query: "rollback" }, { root: proj }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    expect(result.output).toContain("**deploy-flow**");
    // The reference note rides the match line so the model sees the depth.
    expect(result.output).toContain("(references: ci-checklist, rollback)");
  });

  it("multi-word queries rank skills that match MORE of the query higher", () => {
    const tool = searchTool(root());
    const result = tool.execute({ query: "error testing" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n").filter((l) => l.startsWith("- **"));
    // error-testing matches BOTH terms (name word "error" + name substring
    // "testing") — it must outrank single-term matches like testing.
    expect(lines[0]).toContain("**error-testing**");
    expect(result.output).toContain("**testing**");
  });

  it("the 8-result CAP: a broad query returns 8 ranked matches + the overflow note", () => {
    const tool = searchTool(root());
    // Every builtin description contains "NOT for" — the broadest query.
    const result = tool.execute({ query: "for" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines).toHaveLength(8);
    expect(result.output).toMatch(/…and \d+ more matches — narrow the query/);
  });

  it("the honest no-match (ok: true, the alternatives named)", () => {
    const tool = searchTool(root());
    const result = tool.execute({ query: "zzzznothingqqq" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no matches among the");
    expect(result.output).toContain("Try a different keyword");
  });

  it("the computer-use gate: while the master switch is OFF, search never advertises it", () => {
    expect(getSkill(db, "skill_builtin_computer_use")?.enabled).toBe(true); // enabled row…
    const tool = searchTool(root()); // …but the master switch gates it out
    const result = tool.execute({ query: "computer" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.output).not.toContain("**computer-use**");
    // Flip the switch ON → it becomes searchable (same gate read_skill uses).
    setComputerUseSettings(db, { enabled: true });
    const on = tool.execute({ query: "computer" }, { root: root() }) as { ok: boolean; output: string };
    expect(on.output).toContain("**computer-use**");
  });

  it("disabled rows never match (the enable/disable contract read_skill enforces)", () => {
    updateSkill(db, "skill_builtin_error_testing", { enabled: false });
    const tool = searchTool(root());
    const result = tool.execute({ query: "error" }, { root: root() }) as { ok: boolean; output: string };
    expect(result.output).not.toContain("**error-testing**");
    // Re-enable restores it (the row never left).
    updateSkill(db, "skill_builtin_error_testing", { enabled: true });
    const back = tool.execute({ query: "error" }, { root: root() }) as { ok: boolean; output: string };
    expect(back.output).toContain("**error-testing**");
  });

  it("the agent allowlist filters the searchable set exactly like read_skill's loads", () => {
    const agent = createAgent(db, { name: "Planner-only", skills: ["planning"] });
    const tool = searchTool(root(), agent.id);
    const unrelated = tool.execute({ query: "error" }, { root: root() }) as { ok: boolean; output: string };
    expect(unrelated.output).toContain("no matches among the 1 skills");
    const related = tool.execute({ query: "plan" }, { root: root() }) as { ok: boolean; output: string };
    expect(related.output).toContain("**planning**");
  });

  it("read_skill and search_skills agree by construction (one shared resolver, end to end)", () => {
    // The strongest form of the R96-D contract: every name search_skills
    // returns, read_skill can load — same db, same root, same agent.
    const proj = projectRootWith({
      "deploy-flow": {
        skill: `---
name: deploy-flow
description: Ship the deploy flow.
---
Body of the deploy-flow skill.`,
      },
    });
    const tools = buildTools(proj);
    const search = tools[1]!;
    const read = tools[0]!;
    const found = search.execute({ query: "deploy" }, { root: proj }) as { ok: boolean; output: string };
    expect(found.ok).toBe(true);
    const names = [...found.output.matchAll(/\*\*([a-z0-9-]+)\*\*/g)].map((m) => m[1]);
    for (const name of names) {
      const loaded = read.execute({ name }, { root: proj }) as { ok: boolean; output: string };
      expect(loaded.ok).toBe(true);
    }
  });
});
