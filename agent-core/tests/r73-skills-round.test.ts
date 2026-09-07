/**
 * ROUND-73 (R73-d) — the SKILLS half of the round (18 → 20):
 *
 *   D1 — TWO new built-in skills: spec-planning + performance — fixed ids
 *        skill_builtin_spec_planning / skill_builtin_performance,
 *        sortOrder 18-19, INSERT OR IGNORE (fresh AND existing DBs converge
 *        on 20; user edits persist). The R73 queue's "+2 skills": the
 *        spec-writing methodology (pairs with the plan task mode landing
 *        this round) and the measurement-first optimization methodology —
 *        in the R71/R72 house style: trigger-rich descriptions ("Use when
 *        [verbatim user phrasings]. [what it delivers]. NOT for [adjacent
 *        case]." — the description is the ONLY thing the model sees at
 *        trigger time), ~1.9KB bodies, iron laws in caps, red-flag/
 *        anti-pattern tables, ACUTE's real tool names, no emoji.
 *   D2 — the discipline contracts pinned per body: the canonical spec
 *        sections, the question budget, the approval gate; the
 *        measure-first iron law, the profiling ladder, the receipt rules.
 *   D3 — the INSERT OR IGNORE contract extended to 20: idempotent
 *        re-seeds, deleted rows revive on reopen, user edits persist,
 *        disable hides without deleting.
 *   D4 — FLOW-THROUGH: the two new descriptions ride the prompt SKILLS
 *        section verbatim (ctx-driven — nothing hardcoded), and the DB
 *        round-trip lists all twenty.
 *
 * Sibling rounds cover the rest of R73: the generalized system-reminders
 * renderer + budget (R73-d, tests/r73-system-reminders.test.ts), the
 * task-modes wave (R73-a/b/c).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  getSkill,
  listEnabledSkills,
  listSkills,
  seedBuiltinSkills,
  updateSkill,
} from "../src/storage/skills";
import { buildSectionText } from "../src/agents/prompts";
import type { PromptContext } from "../src/agents/prompts";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r73d-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** The two R73-d additions — fixed ids are the INSERT OR IGNORE keys. */
const R73_D_BUILTINS: ReadonlyArray<{
  name: string;
  id: string;
  sortOrder: number;
  triggerPhrase: string;
  notFor: string;
  tools: ReadonlyArray<string>;
}> = [
  {
    name: "spec-planning",
    id: "skill_builtin_spec_planning",
    sortOrder: 18,
    triggerPhrase: "'write a spec'",
    notFor: "quick fixes",
    tools: ["search_code", "read_file", "write_file"],
  },
  {
    name: "performance",
    id: "skill_builtin_performance",
    sortOrder: 19,
    triggerPhrase: "'make it faster'",
    notFor: "code style",
    tools: ["run_command", "read_file"],
  },
];

/** The full twenty — the fixed order the R70/R71/R72/R73 rounds established. */
const EXPECTED_TWENTY: ReadonlyArray<string> = [
  "computer-use",
  "code-review",
  "debugging",
  "testing",
  "git-workflow",
  "web-research",
  "project-init",
  "browser-use",
  "focused-fix",
  "zero-hallucination",
  "self-eval",
  "ship-gate",
  "tdd",
  "api-design",
  "frontend-craft",
  "typescript-craft",
  "security-review",
  "refactoring",
  "spec-planning",
  "performance",
];

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the two new builtins seed (18 → 20)
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-d D1: two new methodology builtins (18 → 20)", () => {
  it("TWENTY builtins seed in the fixed order, fixed ids, sortOrder 0-19, all enabled", () => {
    const builtins = listSkills(db).filter((s) => s.source === "builtin");
    expect(builtins.map((s) => s.name)).toEqual(EXPECTED_TWENTY);
    expect(builtins.map((s) => s.id)).toEqual([
      "skill_builtin_computer_use",
      "skill_builtin_code_review",
      "skill_builtin_debugging",
      "skill_builtin_testing",
      "skill_builtin_git_workflow",
      "skill_builtin_web_research",
      "skill_builtin_project_init",
      "skill_builtin_browser_use",
      "skill_builtin_focused_fix",
      "skill_builtin_zero_hallucination",
      "skill_builtin_self_eval",
      "skill_builtin_ship_gate",
      "skill_builtin_tdd",
      "skill_builtin_api_design",
      "skill_builtin_frontend_craft",
      "skill_builtin_typescript_craft",
      "skill_builtin_security_review",
      "skill_builtin_refactoring",
      ...R73_D_BUILTINS.map((b) => b.id),
    ]);
    expect(builtins.map((s) => s.sortOrder)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(builtins.every((s) => s.enabled)).toBe(true);
    // sortOrders are unique across all twenty (the listing order contract).
    expect(new Set(builtins.map((s) => s.sortOrder)).size).toBe(20);
  });

  it.each(R73_D_BUILTINS)(
    "%s: trigger-rich description — 'Use when' + at least three verbatim phrasings + 'Delivers' + 'NOT for', 400-500 chars",
    (expected) => {
      const skill = getSkill(db, expected.id);
      expect(skill).toBeDefined();
      const description = skill?.description ?? "";
      // The Pocock/karpathy convention, pinned per skill (case-insensitive).
      expect(description).toMatch(/use when /i);
      expect(description).toMatch(/delivers /i);
      expect(description).toMatch(/not for /i);
      // The storage cap holds (the DB slices at 500 — the seed must not need it).
      expect(description.length).toBeLessThanOrEqual(500);
      expect(description.length).toBeGreaterThanOrEqual(400);
      // The exact verbatim trigger phrase + the negative scope, both present.
      expect(description).toContain(expected.triggerPhrase);
      expect(description).toMatch(new RegExp(`not for [^.]*${expected.notFor.replace(/[()]/g, "\\$&")}`, "i"));
      // Trigger-RICH: at least three quoted verbatim user phrasings.
      expect(description.match(/'[^']{3,}'/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    },
  );

  it("the two new descriptions are distinct — from each other AND from the eighteen older ones", () => {
    const descriptions = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => s.description);
    expect(descriptions).toHaveLength(20);
    expect(new Set(descriptions).size).toBe(20);
  });

  it("the two new names are lowercase slugs that do not shadow older builtins (the naming contract)", () => {
    const names = listSkills(db).filter((s) => s.source === "builtin").map((s) => s.name);
    expect(new Set(names).size).toBe(20);
    for (const name of R73_D_BUILTINS.map((b) => b.name)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the two new bodies: house format + the discipline contracts
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-d D2: the two new bodies (house format)", () => {
  it.each(R73_D_BUILTINS)(
    "%s: '# Skill:' prefix, 1.5-2.0KB, <= 60 lines, no emoji, ACUTE's real tools named",
    (expected) => {
      const body = getSkill(db, expected.id)?.body ?? "";
      expect(body.startsWith(`# Skill: ${expected.name}`)).toBe(true);
      // The R73-d design band: 1.5-1.95KB bodies (hard bound 2.0KB), <= 60 lines.
      expect(body.length).toBeGreaterThanOrEqual(1_500);
      expect(body.length).toBeLessThanOrEqual(2_000);
      expect(body.trim().split("\n").length).toBeLessThanOrEqual(60);
      // No emoji anywhere in the new bodies (arrows are not pictographs).
      expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
      // ACUTE's real tool surface is named, not invented tools.
      for (const tool of expected.tools) {
        expect(body).toContain(tool);
      }
    },
  );
});

describe("R73-d D2: the two new bodies (discipline contracts)", () => {
  it("spec-planning: DECISION DOCUMENT framing, the canonical eight sections in order, interfaces FIRST, the question budget, the approval gate, the anti-patterns, the plan-mode final line", () => {
    const body = getSkill(db, "skill_builtin_spec_planning")?.body ?? "";
    // The framing, verbatim.
    expect(body).toContain("A spec is a DECISION DOCUMENT, not a wishlist");
    expect(body).toContain("every section removes a decision from the future");
    // The canonical sections, all eight, in order (numbered list order).
    const ordered = ["GOAL", "SCOPE", "NON-GOALS", "INTERFACES", "DATA", "ERROR PATHS", "ACCEPTANCE CRITERIA", "RISKS"];
    let cursor = -1;
    for (const section of ordered) {
      const at = body.indexOf(`. ${section} —`);
      expect(at).toBeGreaterThan(cursor); // each section after the previous
      cursor = at;
    }
    // Interfaces FIRST because they are the expensive decisions.
    expect(body).toContain("field by field, FIRST: interfaces are the expensive decisions");
    // Acceptance criteria are TESTABLE statements.
    expect(body).toContain("TESTABLE statements");
    expect(body).toContain("A criterion you cannot turn into a check is a hope");
    // The question budget: R71's anti-question-padding, spec-shaped.
    expect(body).toContain("At most FIVE clarifying questions, batched in ONE message");
    expect(body).toContain("EACH with a proposed default");
    // The approval gate.
    expect(body).toContain("A spec is DONE when the owner approves it, not when it is long");
    // The anti-patterns table: each named failure mode.
    expect(body).toContain("Vague acceptance criteria");
    expect(body).toContain("Hidden non-goals");
    expect(body).toContain("Interface-by-implementation");
    expect(body).toContain("A risk-free risk section");
    // The body's FINAL line pairs with the plan task mode (R73-a/b).
    expect(body.trimEnd().endsWith("Pairs with the plan task mode.")).toBe(true);
  });

  it("performance: the MEASURE-FIRST iron law, the premature-optimization red flags, the profiling ladder, 20/80, complexity-first, benchmark receipts, honesty rules, the stop condition", () => {
    const body = getSkill(db, "skill_builtin_performance")?.body ?? "";
    // The iron law, verbatim and in caps: no optimization without both halves.
    expect(body).toContain("IRON LAW: NO OPTIMIZATION WITHOUT A BEFORE-NUMBER AND A NAMED BOTTLENECK");
    expect(body).toContain("No pair, no optimization");
    // The premature-optimization red-flags list: the model's own excuses.
    expect(body).toMatch(/## Red flags — premature optimization/);
    expect(body).toContain(`"It's probably the database" → a guess. Measure.`);
    expect(body).toContain(`"I'll add a cache" → before knowing what it misses? No.`);
    // The profiling ladder: three rungs, cheapest-first.
    expect(body).toMatch(/## The profiling ladder — cheapest tool that sees the suspected layer/);
    expect(body).toMatch(/1\. APP-LEVEL TIMING/);
    expect(body).toMatch(/2\. LANGUAGE PROFILER/);
    expect(body).toMatch(/3\. SYSTEM TOOLS/);
    // The 20/80 reality + complexity before constant factors.
    expect(body).toContain("One bottleneck usually dominates");
    expect(body).toContain("three micro-optimizations around a 90% bottleneck are invisible");
    expect(body).toContain("O(n²) → O(n) beats micro-tuning");
    // Benchmark receipts: same machine, warm-up, variance.
    expect(body).toContain("BEFORE and AFTER, same machine, same command");
    expect(body).toContain("warm-up discarded");
    expect(body).toContain("run-to-run VARIANCE noted");
    expect(body).toContain(`a 5% "win" inside 10% noise is not a win`);
    // The honesty rules.
    expect(body).toContain("NEVER claim a speedup without a receipt");
    expect(body).toContain(`"Feels faster" is not a result`);
    // The stop condition.
    expect(body).toMatch(/## Stop condition/);
    expect(body).toContain("Stop when the target is met");
    expect(body).toContain("optimization has diminishing returns, complexity does not");
  });

  /** The 2-3 highest-value lines per skill, verbatim — the lines the
   * model must not lose in any future edit (each one is the skill). */
  const KEY_RULES: ReadonlyArray<[name: string, lines: ReadonlyArray<string>]> = [
    ["spec-planning", ["A hidden non-goal is a future argument", "Ask nothing you could answer from the repo"]],
    ["performance", ["No pair, no optimization", `a 5% "win" inside 10% noise is not a win`]],
  ];
  it.each(KEY_RULES)("%s: key rules pinned verbatim", (name, lines) => {
    const id = R73_D_BUILTINS.find((b) => b.name === name)?.id ?? "";
    const body = getSkill(db, id)?.body ?? "";
    expect(body).not.toBe("");
    for (const line of lines) {
      expect(body).toContain(line);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — the INSERT OR IGNORE contract, twenty-strong
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-d D3: INSERT OR IGNORE with 20 builtins", () => {
  it("an explicit re-seed is idempotent: still exactly 20 rows, unique names, unique ids", () => {
    seedBuiltinSkills(db);
    seedBuiltinSkills(db);
    const rows = db.prepare("SELECT * FROM skills").all() as Array<{ id: string; name: string; source: string }>;
    const builtins = rows.filter((r) => r.source === "builtin");
    expect(builtins).toHaveLength(20);
    expect(new Set(builtins.map((r) => r.id)).size).toBe(20);
    expect(new Set(builtins.map((r) => r.name)).size).toBe(20);
  });

  it("deleted new-builtin rows revive on reopen (an existing pre-R73 DB converges on 20)", () => {
    const path = join(tempDir, "converge.db");
    const existing = openDatabase(path); // an "existing user DB" — already seeded
    try {
      // The user nukes the two R73-d rows and one older one (say, by hand).
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_spec_planning");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_performance");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_tdd");
      expect(listSkills(existing).filter((s) => s.source === "builtin")).toHaveLength(17);
    } finally {
      existing.close();
    }
    // Next open: the seeding at open recreates the missing rows.
    const reopened = openDatabase(path);
    try {
      const builtins = listSkills(reopened).filter((s) => s.source === "builtin");
      expect(builtins).toHaveLength(20);
      expect(getSkill(reopened, "skill_builtin_spec_planning")?.name).toBe("spec-planning");
      expect(getSkill(reopened, "skill_builtin_spec_planning")?.body).toContain("A spec is a DECISION DOCUMENT");
      expect(getSkill(reopened, "skill_builtin_performance")?.body).toContain(
        "NO OPTIMIZATION WITHOUT A BEFORE-NUMBER",
      );
      expect(getSkill(reopened, "skill_builtin_tdd")?.body).toContain("NEVER WRITE THE TEST AFTER THE CODE");
    } finally {
      reopened.close();
    }
  });

  it("user edits to the new builtins persist across reseeds (the R70/R71/R72 contract, unchanged)", () => {
    updateSkill(db, "skill_builtin_spec_planning", { body: "MY SPEC-PLANNING EDIT" });
    updateSkill(db, "skill_builtin_performance", { description: "MY PERFORMANCE DESC" });
    seedBuiltinSkills(db);
    expect(getSkill(db, "skill_builtin_spec_planning")?.body).toBe("MY SPEC-PLANNING EDIT");
    expect(getSkill(db, "skill_builtin_performance")?.description).toBe("MY PERFORMANCE DESC");
    // And the edits did not duplicate the rows.
    expect(listSkills(db).filter((s) => s.name === "spec-planning")).toHaveLength(1);
    expect(listSkills(db).filter((s) => s.name === "performance")).toHaveLength(1);
  });

  it("disabling a new builtin hides it from the enabled set without deleting the row", () => {
    updateSkill(db, "skill_builtin_spec_planning", { enabled: false });
    expect(listEnabledSkills(db).map((s) => s.name)).not.toContain("spec-planning");
    expect(listSkills(db).filter((s) => s.source === "builtin")).toHaveLength(20);
    // Re-enable restores it (the row never left).
    updateSkill(db, "skill_builtin_spec_planning", { enabled: true });
    expect(listEnabledSkills(db).map((s) => s.name)).toContain("spec-planning");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — the new descriptions flow into the prompt SKILLS section (ctx-driven)
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-d D4: the two new descriptions ride the prompt SKILLS section verbatim", () => {
  function promptCtx(skills: ReadonlyArray<{ name: string; description: string }>): PromptContext {
    return {
      projectName: "R73dProject",
      rootPath: join(tempDir, "never-exists"),
      toolNames: [],
      maxTurns: 40,
      maxOuterLoops: 5,
      skills,
    };
  }

  it("all twenty builtins render as '- **name** — description' with the FULL new descriptions", () => {
    const builtins = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => ({ name: s.name, description: s.description }));
    expect(builtins).toHaveLength(20);

    const section = buildSectionText(promptCtx(builtins), "skills") ?? "";
    expect(section).toContain("## SKILLS (load with read_skill)");
    expect(section).toContain("call read_skill with its name FIRST");
    for (const skill of builtins) {
      expect(section).toContain(`- **${skill.name}** — ${skill.description}`);
    }
    // The trigger surface is what the model sees: the phrase-level proof
    // for the two new skills.
    expect(section).toContain("'write a spec'");
    expect(section).toContain("'make it faster'");
    // The reload affordance still rides the section (R70-c D6).
    expect(section).toContain("A skill body that appears truncated after context compaction can be RELOADED: call read_skill again.");
  });

  it("the DB round-trip: a seeded DB lists all TWENTY through listSkills AND listEnabledSkills", () => {
    expect(listSkills(db).filter((s) => s.source === "builtin")).toHaveLength(20);
    expect(listEnabledSkills(db)).toHaveLength(20);
    for (const expected of R73_D_BUILTINS) {
      const viaList = listSkills(db).find((s) => s.name === expected.name);
      expect(viaList?.id).toBe(expected.id);
      expect(viaList?.sortOrder).toBe(expected.sortOrder);
      const viaEnabled = listEnabledSkills(db).find((s) => s.name === expected.name);
      expect(viaEnabled?.body).toContain(`# Skill: ${expected.name}`);
    }
  });
});
