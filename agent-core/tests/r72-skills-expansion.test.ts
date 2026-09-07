/**
 * ROUND-72 (R72-b) — the SKILLS EXPANSION round (12 → 18):
 *
 *   D1 — SIX new built-in skills: tdd, api-design, frontend-craft,
 *        typescript-craft, security-review, refactoring — fixed ids
 *        skill_builtin_*, sortOrder 12-17, INSERT OR IGNORE (fresh AND
 *        existing DBs converge on 18; user edits persist). The six
 *        engineering CRAFTS the R70/R71 families did not cover, in the
 *        R71 house style: trigger-rich descriptions ("Use when [verbatim
 *        user phrasings]. [what it delivers]. NOT for [adjacent case]."
 *        — the description is the ONLY thing the model sees at trigger
 *        time), 1.2-1.9KB bodies, iron laws in caps, pre-built
 *        output-format blocks, ACUTE's real tool names, no emoji.
 *   D2 — the discipline contracts pinned per body: the iron laws, the
 *        ordered rules, the anti-pattern/red-flag tables, the output
 *        blocks, and 2-3 highest-value lines verbatim per skill.
 *   D3 — the INSERT OR IGNORE contract extended to 18: idempotent
 *        re-seeds, deleted rows revive on reopen, user edits persist,
 *        disable hides without deleting.
 *   D4 — FLOW-THROUGH: the six new descriptions ride the prompt SKILLS
 *        section verbatim (the section is ctx-driven — nothing
 *        hardcoded; pinned here so a future regression gets caught).
 *
 * Sibling rounds cover the rest of R72: task-hints (R72-a), references/
 * depth (R72-c), per-directory conventions (R72-d).
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
  tempDir = mkdtempSync(join(tmpdir(), "acute-r72b-"));
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

/** The six R72-b additions — fixed ids are the INSERT OR IGNORE keys. */
const R72_BUILTINS: ReadonlyArray<{
  name: string;
  id: string;
  sortOrder: number;
  triggerPhrase: string;
  notFor: string;
  tools: ReadonlyArray<string>;
}> = [
  {
    name: "tdd",
    id: "skill_builtin_tdd",
    sortOrder: 12,
    triggerPhrase: "'write the test first'",
    notFor: "testing",
    tools: ["run_command", "edit_file", "search_code", "read_file", "todo_write"],
  },
  {
    name: "api-design",
    id: "skill_builtin_api_design",
    sortOrder: 13,
    triggerPhrase: "'add an endpoint'",
    notFor: "GraphQL schemas",
    tools: ["search_code", "run_command"],
  },
  {
    name: "frontend-craft",
    id: "skill_builtin_frontend_craft",
    sortOrder: 14,
    triggerPhrase: "'fix the layout'",
    notFor: "backend logic",
    tools: ["search_code", "read_file"],
  },
  {
    name: "typescript-craft",
    id: "skill_builtin_typescript_craft",
    sortOrder: 15,
    triggerPhrase: "'fix the any'",
    notFor: "build config",
    tools: ["run_command", "search_code"],
  },
  {
    name: "security-review",
    id: "skill_builtin_security_review",
    sortOrder: 16,
    triggerPhrase: "'is this safe'",
    notFor: "code-review",
    tools: ["git_diff", "search_code"],
  },
  {
    name: "refactoring",
    id: "skill_builtin_refactoring",
    sortOrder: 17,
    triggerPhrase: "'clean this up'",
    notFor: "debugging",
    tools: ["run_command", "todo_write"],
  },
];

/** The full eighteen — the fixed order the R70/R71/R72 rounds established. */
const EXPECTED_EIGHTEEN: ReadonlyArray<string> = [
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
];

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the six new builtins seed (12 → 18)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-b D1: six new craft builtins (12 → 18)", () => {
  it("EIGHTEEN builtins seed in the fixed order, fixed ids, sortOrder 0-17, all enabled", () => {
    const builtins = listSkills(db).filter((s) => s.source === "builtin");
    expect(builtins.map((s) => s.name)).toEqual(EXPECTED_EIGHTEEN);
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
      ...R72_BUILTINS.map((b) => b.id),
    ]);
    expect(builtins.map((s) => s.sortOrder)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(builtins.every((s) => s.enabled)).toBe(true);
  });

  it.each(R72_BUILTINS)(
    "%s: trigger-rich description — 'Use when' + the verbatim phrase + 'Delivers' + 'NOT for' the adjacent case, 160-500 chars",
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
      expect(description.length).toBeGreaterThanOrEqual(160);
      // The exact verbatim trigger phrase + the negative scope, both present.
      expect(description).toContain(expected.triggerPhrase);
      expect(description).toMatch(new RegExp(`not for [^.]*${expected.notFor.replace(/[()]/g, "\\$&")}`, "i"));
      // Every description is trigger-rich: at least one quoted phrasing.
      expect(description).toMatch(/'[^']{3,}'/);
    },
  );

  it("the six new descriptions are distinct — from each other AND from the twelve older ones", () => {
    const descriptions = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => s.description);
    expect(descriptions).toHaveLength(18);
    expect(new Set(descriptions).size).toBe(18);
  });

  it("the six names are lowercase slugs that do not shadow older builtins (the naming contract)", () => {
    const names = listSkills(db).filter((s) => s.source === "builtin").map((s) => s.name);
    expect(new Set(names).size).toBe(18);
    for (const name of R72_BUILTINS.map((b) => b.name)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the six new bodies: house format + the discipline contracts
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-b D2: the six new bodies (house format)", () => {
  it.each(R72_BUILTINS)(
    "%s: '# Skill:' prefix, 1.2-1.9KB, <= 60 lines, no emoji, ACUTE's real tools named",
    (expected) => {
      const body = getSkill(db, expected.id)?.body ?? "";
      expect(body.startsWith(`# Skill: ${expected.name}`)).toBe(true);
      // The R72-d design band: 1.2-1.9KB bodies, <= 60 lines (house format).
      expect(body.length).toBeGreaterThanOrEqual(1_200);
      expect(body.length).toBeLessThanOrEqual(1_900);
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

describe("R72-b D2: the six new bodies (discipline contracts)", () => {
  it("tdd: the iron law, the watched-fail rule, minimum-to-green, refactor-only-on-green, triangulation, the anti-pattern table, TEST FIRST block", () => {
    const body = getSkill(db, "skill_builtin_tdd")?.body ?? "";
    // The iron law, verbatim and in caps.
    expect(body).toContain("IRON LAW: NEVER WRITE THE TEST AFTER THE CODE TO FIT IT");
    // The loop, in order, with the watched-fail rule (the load-bearing line).
    expect(body).toMatch(/1\. RED — write ONE failing test/);
    expect(body).toMatch(/RUN it .*and WATCH it fail/);
    expect(body).toContain("A test you have not watched fail proves nothing");
    expect(body).toMatch(/2\. GREEN — write the MINIMUM code that makes it pass/);
    expect(body).toMatch(/3\. REFACTOR — only on green, and only structure/);
    // Triangulation for the second case.
    expect(body).toMatch(/## Triangulation/);
    expect(body).toContain("Two examples triangulate the abstraction");
    // The anti-pattern table: each excuse quoted + STOP.
    expect(body).toContain("That is not a test, it is a transcript.");
    expect(body).toContain("A red test is information.");
    expect(body).toContain("That is lying with a green check.");
    // The pre-built output-format block.
    expect(body).toContain("TEST FIRST");
    expect(body).toContain("RED:");
    expect(body).toContain("GREEN:");
    expect(body).toContain("REFACTOR:");
  });

  it("api-design: contract-first iron law, fail-closed boundary, the error envelope, additive-only evolution, pagination caps, API CONTRACT block", () => {
    const body = getSkill(db, "skill_builtin_api_design")?.body ?? "";
    // The iron law + the contract pieces it names.
    expect(body).toContain("IRON LAW: THE CONTRACT IS WRITTEN BEFORE THE HANDLER");
    expect(body).toContain("Method + path + request schema + response schema + error codes");
    // Validation at the boundary, fail closed.
    expect(body).toMatch(/## Validate at the boundary — fail closed/);
    expect(body).toContain("Fail closed: bad input returns an error");
    // The error envelope rule (one shape, everywhere).
    expect(body).toMatch(/## The error envelope/);
    expect(body).toContain("the same shape: code + message + detail");
    // Additive-only evolution.
    expect(body).toMatch(/## Additive-only evolution/);
    expect(body).toContain("NEVER remove, rename, or repurpose a shipped field");
    // Pagination + caps on list endpoints.
    expect(body).toMatch(/## Lists: paginate and cap/);
    expect(body).toContain("a hard max page size");
    // The pre-built output-format block.
    expect(body).toContain("API CONTRACT");
    expect(body).toContain("REQUEST:");
    expect(body).toContain("RESPONSE:");
    expect(body).toContain("ERRORS:");
    expect(body).toContain("COMPAT:");
  });

  it("frontend-craft: state-colocation iron law, stable-identity keys, derived-not-stored, controlled inputs, semantic HTML, the a11y floor, Tailwind discipline, COMPONENT PLAN block", () => {
    const body = getSkill(db, "skill_builtin_frontend_craft")?.body ?? "";
    // The iron law + lift-only-on-proven-sharing.
    expect(body).toContain("IRON LAW: STATE LIVES AS CLOSE TO ITS CONSUMERS AS POSSIBLE");
    expect(body).toMatch(/Lift ONLY when distant components demonstrably read the same value/);
    // Keys from stable identity, never the array index.
    expect(body).toContain("Keys from STABLE IDENTITY, never array index");
    expect(body).toContain("index keys corrupt state on reorder");
    // Derived state computed, not stored; controlled inputs.
    expect(body).toContain("Derived state is COMPUTED, not stored");
    expect(body).toContain("Controlled inputs: value + onChange");
    // Semantic-first HTML.
    expect(body).toContain("A click handler on a div is a bug");
    expect(body).toContain("label htmlFor the input");
    // The a11y floor.
    expect(body).toContain("focus VISIBLE");
    expect(body).toContain("Test with the keyboard, not the mouse");
    expect(body).toMatch(/aria ONLY when semantics cannot express it/);
    // CSS discipline.
    expect(body).toContain("Tailwind utilities composed on the element");
    expect(body).toContain("NO inline style for non-dynamic values");
    // The pre-built output-format block.
    expect(body).toContain("COMPONENT PLAN");
    expect(body).toContain("STATE:");
    expect(body).toContain("DERIVED:");
    expect(body).toContain("PROPS:");
    expect(body).toContain("A11Y:");
    expect(body).toContain("STYLE:");
  });

  it("typescript-craft: illegal-states iron law, union-over-flags modeling, exhaustiveness, the any ban + cast justification, inference vs annotation, generics discipline, TYPE PLAN block", () => {
    const body = getSkill(db, "skill_builtin_typescript_craft")?.body ?? "";
    // The iron law.
    expect(body).toContain("IRON LAW: IF A STATE IS ILLEGAL, ITS TYPE MUST MAKE IT UNREPRESENTABLE");
    // Modeling: unions + literals over flag soup.
    expect(body).toContain("Prefer unions + literal types over flag soup");
    expect(body).toContain('{ kind: "loading" }');
    // Discriminated-union narrowing + exhaustiveness via never.
    expect(body).toMatch(/## Narrow with discriminated unions/);
    expect(body).toContain("a default that assigns to never turns a missed case into a compile error");
    expect(body).toContain("NEVER cast to bypass a type error");
    // The any ban: unknown + a narrowing guard; casts need justification.
    expect(body).toContain("any is banned");
    expect(body).toMatch(/unknown \+ a NARROWING GUARD/);
    expect(body).toContain("A cast without a comment is a bug with a syntax light.");
    // Inference vs annotation.
    expect(body).toContain("Annotate EXPORTED signatures");
    expect(body).toContain("Infer locals");
    // Generics only when variance is real.
    expect(body).toMatch(/## Generics only when variance is real/);
    // The pre-built output-format block.
    expect(body).toContain("TYPE PLAN");
    expect(body).toContain("DOMAIN:");
    expect(body).toContain("BOUNDARIES:");
    expect(body).toContain("BANNED:");
    expect(body).toContain("EXPORTS:");
  });

  it("security-review: the big five with their exact tests, boundary validation, the adversarial framing, SECURITY VERDICT block", () => {
    const body = getSkill(db, "skill_builtin_security_review")?.body ?? "";
    // The adversarial framing.
    expect(body).toContain("as an attacker who has the source");
    // The big five, each with its exact test.
    expect(body).toMatch(/## The big five — each with its exact test/);
    expect(body).toMatch(/1\. INJECTION/);
    expect(body).toMatch(/parameterized statements only/);
    expect(body).toContain("argument arrays, never an interpolated shell string");
    expect(body).toMatch(/2\. PATH TRAVERSAL/);
    expect(body).toContain("startsWith(root + path separator)");
    expect(body).toMatch(/3\. SECRETS/);
    expect(body).toContain("nothing in code, logs, or commits");
    expect(body).toContain("BEFORE commit");
    expect(body).toMatch(/4\. AUTHZ/);
    expect(body).toContain("Check where the DATA is fetched, not where the UI hides the button");
    expect(body).toContain("Per-route, not per-habit");
    expect(body).toMatch(/5\. FAIL CLOSED/);
    expect(body).toContain("has converted an exception into a bypass");
    // Input validation at boundaries.
    expect(body).toMatch(/## Input validation at boundaries/);
    expect(body).toContain("validate where trust begins");
    // The pre-built output-format block (findings with severity + the exact
    // exploit path, or CLEAN with what was checked).
    expect(body).toContain("SECURITY VERDICT");
    expect(body).toContain("FINDINGS:");
    expect(body).toContain("SEVERITY");
    expect(body).toContain("the EXACT exploit path");
    expect(body).toContain("CLEAN:");
  });

  it("refactoring: characterization-tests iron law, single-mechanical-move, rename-before-restructure, the honesty rule, red flags, REFACTOR PLAN block", () => {
    const body = getSkill(db, "skill_builtin_refactoring")?.body ?? "";
    // The iron law (tests-first-or-no-move).
    expect(body).toContain("IRON LAW: NO MOVE WITHOUT A GREEN CHARACTERIZATION TEST FIRST");
    expect(body).toContain("writing those tests IS the first task — or the refactor is refused");
    // Behavior preservation + the honesty rule (a rewrite is a new module).
    expect(body).toContain("Behavior is PRESERVED");
    expect(body).toMatch(/it is a rewrite; name it, plan it, get agreement BEFORE moving/);
    // One mechanical move per step.
    expect(body).toContain("One MECHANICAL move per step");
    expect(body).toContain("NEVER two unverified moves in a row");
    expect(body).toContain("a failure must point at the one change you just made");
    // Rename before restructure.
    expect(body).toContain("Rename BEFORE restructure");
    // Stop when the pain is gone + the campsite contract.
    expect(body).toContain("STOP when the pain is gone");
    expect(body).toContain("Campsite rule");
    // The step ledger.
    expect(body).toContain("todo_write");
    // Red flags quoting the model's own excuses.
    expect(body).toContain("Red mid-refactor means behavior changed");
    expect(body).toContain("That is a rewrite with extra steps");
    // The pre-built output-format block.
    expect(body).toContain("REFACTOR PLAN");
    expect(body).toContain("PAIN:");
    expect(body).toContain("SAFETY NET:");
    expect(body).toContain("MOVES:");
    expect(body).toContain("VERIFY:");
    expect(body).toContain("STOP CONDITION:");
  });

  /** The 2-3 highest-value lines per skill, verbatim — the lines the
   * model must not lose in any future edit (each one is the skill). */
  const KEY_RULES: ReadonlyArray<[name: string, lines: ReadonlyArray<string>]> = [
    ["tdd", ["A test you have not watched fail proves nothing", "Two examples triangulate the abstraction"]],
    ["api-design", ["Consumers exist the moment you ship", "a response that shifted is someone else's outage"]],
    ["frontend-craft", ["A click handler on a div is a bug", "stored derived state is a desync"]],
    ["typescript-craft", ["A cast is a confession", "A cast without a comment is a bug with a syntax light."]],
    ["security-review", ["only the server-side check counts", "has converted an exception into a bypass"]],
    ["refactoring", ["or the refactor is refused", "An unverified item is an open risk, not a completed move"]],
  ];
  it.each(KEY_RULES)("%s: key rules pinned verbatim", (name, lines) => {
    const id = R72_BUILTINS.find((b) => b.name === name)?.id ?? "";
    const body = getSkill(db, id)?.body ?? "";
    expect(body).not.toBe("");
    for (const line of lines) {
      expect(body).toContain(line);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — the INSERT OR IGNORE contract, eighteen-strong
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-b D3: INSERT OR IGNORE with 18 builtins", () => {
  it("an explicit re-seed is idempotent: still exactly 18 rows, unique names, unique ids", () => {
    seedBuiltinSkills(db);
    seedBuiltinSkills(db);
    const rows = db.prepare("SELECT * FROM skills").all() as Array<{ id: string; name: string; source: string }>;
    const builtins = rows.filter((r) => r.source === "builtin");
    expect(builtins).toHaveLength(18);
    expect(new Set(builtins.map((r) => r.id)).size).toBe(18);
    expect(new Set(builtins.map((r) => r.name)).size).toBe(18);
  });

  it("deleted new-builtin rows revive on reopen (an existing pre-R72 DB converges on 18)", () => {
    const path = join(tempDir, "converge.db");
    const existing = openDatabase(path); // an "existing user DB" — already seeded
    try {
      // The user nukes two of the six new rows (say, by hand).
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_tdd");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_refactoring");
      expect(listSkills(existing).filter((s) => s.source === "builtin")).toHaveLength(16);
    } finally {
      existing.close();
    }
    // Next open: the seeding at open recreates the missing rows.
    const reopened = openDatabase(path);
    try {
      const builtins = listSkills(reopened).filter((s) => s.source === "builtin");
      expect(builtins).toHaveLength(18);
      expect(getSkill(reopened, "skill_builtin_tdd")?.name).toBe("tdd");
      expect(getSkill(reopened, "skill_builtin_tdd")?.body).toContain("NEVER WRITE THE TEST AFTER THE CODE");
      expect(getSkill(reopened, "skill_builtin_refactoring")?.body).toContain("NO MOVE WITHOUT A GREEN CHARACTERIZATION TEST");
    } finally {
      reopened.close();
    }
  });

  it("user edits to the new builtins persist across reseeds (the R70/R71 contract, unchanged)", () => {
    updateSkill(db, "skill_builtin_api_design", { body: "MY API-DESIGN EDIT" });
    updateSkill(db, "skill_builtin_tdd", { description: "MY TDD DESC" });
    seedBuiltinSkills(db);
    expect(getSkill(db, "skill_builtin_api_design")?.body).toBe("MY API-DESIGN EDIT");
    expect(getSkill(db, "skill_builtin_tdd")?.description).toBe("MY TDD DESC");
    // And the edits did not duplicate the rows.
    expect(listSkills(db).filter((s) => s.name === "api-design")).toHaveLength(1);
    expect(listSkills(db).filter((s) => s.name === "tdd")).toHaveLength(1);
  });

  it("disabling a new builtin hides it from the enabled set without deleting the row", () => {
    updateSkill(db, "skill_builtin_security_review", { enabled: false });
    expect(listEnabledSkills(db).map((s) => s.name)).not.toContain("security-review");
    expect(listSkills(db).filter((s) => s.source === "builtin")).toHaveLength(18);
    // Re-enable restores it (the row never left).
    updateSkill(db, "skill_builtin_security_review", { enabled: true });
    expect(listEnabledSkills(db).map((s) => s.name)).toContain("security-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — the new descriptions flow into the prompt SKILLS section (ctx-driven)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-b D4: the six new descriptions ride the prompt SKILLS section verbatim", () => {
  function promptCtx(skills: ReadonlyArray<{ name: string; description: string }>): PromptContext {
    return {
      projectName: "R72bProject",
      rootPath: join(tempDir, "never-exists"),
      toolNames: [],
      maxTurns: 40,
      maxOuterLoops: 5,
      skills,
    };
  }

  it("all eighteen builtins render as '- **name** — description' with the FULL new descriptions", () => {
    const builtins = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => ({ name: s.name, description: s.description }));
    expect(builtins).toHaveLength(18);

    const section = buildSectionText(promptCtx(builtins), "skills") ?? "";
    expect(section).toContain("## SKILLS (load with read_skill)");
    expect(section).toContain("call read_skill with its name FIRST");
    for (const skill of builtins) {
      expect(section).toContain(`- **${skill.name}** — ${skill.description}`);
    }
    // The trigger surface is what the model sees: the phrase-level proof
    // for the six new skills.
    expect(section).toContain("'write the test first'");
    expect(section).toContain("'add an endpoint'");
    expect(section).toContain("'fix the layout'");
    expect(section).toContain("'fix the any'");
    expect(section).toContain("'is this safe'");
    expect(section).toContain("'clean this up'");
    // The reload affordance still rides the section (R70-c D6).
    expect(section).toContain("A skill body that appears truncated after context compaction can be RELOADED: call read_skill again.");
  });
});
