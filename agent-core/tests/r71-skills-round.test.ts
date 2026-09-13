/**
 * ROUND-71 (R71-e3) — the SKILLS ROUND:
 *
 *   D1 — TRIGGER-RICH DESCRIPTIONS: all 12 builtin descriptions follow the
 *        Pocock/karpathy convention — "Use when [verbatim user phrasings].
 *        [what it delivers]. NOT for [adjacent case]." — because the
 *        description is the ONLY thing the model sees at trigger time (the
 *        SKILLS prompt line carries name + description; the body loads on
 *        demand via read_skill). R71-c audit C1: the R70 descriptions were
 *        WHAT-the-skill-does summaries with no trigger surface and no
 *        negative scope.
 *   D2 — the FOUR new built-ins (12 total): focused-fix, zero-hallucination,
 *        self-eval, ship-gate — iron laws in caps, pre-built output-format
 *        blocks, anti-rationalization red flags, ACUTE's real tool names
 *        (R71-c audit C2: none of these disciplines existed as skills).
 *   D3 — the INSERT OR IGNORE contract extended to 12: idempotent re-seeds,
 *        deleted rows revive on reopen (fresh AND existing DBs converge).
 *   D4 — FLOW-THROUGH: the new descriptions ride the prompt SKILLS section
 *        verbatim (the section is ctx-driven — prompts.ts hardcodes nothing,
 *        so the description change needed no prompt edit; pinned here so a
 *        future hardcoding regression gets caught).
 *
 * ROUND-72 (R72-b) RE-PINS: the builtin family grew 12 → 18 (tdd,
 * api-design, frontend-craft, typescript-craft, security-review,
 * refactoring — see tests/r72-skills-expansion.test.ts for the six new
 * skills' own pins). The R71-e3 pins below stay intact for the original
 * four; the counts/orders/contracts extended honestly to eighteen.
 *
 * ROUND-73 (R73-d) RE-PINS: the builtin family grew 18 → 20
 * (spec-planning, performance — see tests/r73-skills-round.test.ts for
 * the two new skills' own pins). The R71-e3/R72-b pins below stay intact
 * for the original ten; the counts/orders/contracts extended honestly to
 * twenty.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  getSkill,
  listSkills,
  seedBuiltinSkills,
  updateSkill,
} from "../src/storage/skills";
import { buildSectionText } from "../src/agents/prompts";
import type { PromptContext } from "../src/agents/prompts";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r71e3-"));
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

/** The twenty-four builtins in fixed order — ids are the INSERT OR IGNORE keys. */
const EXPECTED_BUILTINS: ReadonlyArray<{ name: string; id: string; sortOrder: number }> = [
  { name: "computer-use", id: "skill_builtin_computer_use", sortOrder: 0 },
  { name: "code-review", id: "skill_builtin_code_review", sortOrder: 1 },
  { name: "debugging", id: "skill_builtin_debugging", sortOrder: 2 },
  { name: "testing", id: "skill_builtin_testing", sortOrder: 3 },
  { name: "git-workflow", id: "skill_builtin_git_workflow", sortOrder: 4 },
  { name: "web-research", id: "skill_builtin_web_research", sortOrder: 5 },
  { name: "project-init", id: "skill_builtin_project_init", sortOrder: 6 },
  { name: "browser-use", id: "skill_builtin_browser_use", sortOrder: 7 },
  { name: "focused-fix", id: "skill_builtin_focused_fix", sortOrder: 8 },
  { name: "zero-hallucination", id: "skill_builtin_zero_hallucination", sortOrder: 9 },
  { name: "self-eval", id: "skill_builtin_self_eval", sortOrder: 10 },
  { name: "ship-gate", id: "skill_builtin_ship_gate", sortOrder: 11 },
  // R72-b: the six craft additions ride the same fixed-id contract.
  { name: "tdd", id: "skill_builtin_tdd", sortOrder: 12 },
  { name: "api-design", id: "skill_builtin_api_design", sortOrder: 13 },
  { name: "frontend-craft", id: "skill_builtin_frontend_craft", sortOrder: 14 },
  { name: "typescript-craft", id: "skill_builtin_typescript_craft", sortOrder: 15 },
  { name: "security-review", id: "skill_builtin_security_review", sortOrder: 16 },
  { name: "refactoring", id: "skill_builtin_refactoring", sortOrder: 17 },
  // R73-d: the two methodology additions ride the same fixed-id contract.
  { name: "spec-planning", id: "skill_builtin_spec_planning", sortOrder: 18 },
  { name: "performance", id: "skill_builtin_performance", sortOrder: 19 },
  // ROUND-96 (R96-D): the four owner-named additions ride the same fixed-id
  // contract (their own body pins live in tests/r96-prompts-skills.test.ts).
  { name: "planning", id: "skill_builtin_planning", sortOrder: 20 },
  { name: "ui-design", id: "skill_builtin_ui_design", sortOrder: 21 },
  { name: "error-testing", id: "skill_builtin_error_testing", sortOrder: 22 },
  { name: "large-project-navigation", id: "skill_builtin_large_project_navigation", sortOrder: 23 },
];

/** One verbatim trigger phrase per description — the surface a user/agent
 * would actually think or say (the R71-b1 convention: quotes matter). */
const TRIGGER_PHRASES: ReadonlyArray<[name: string, phrase: string]> = [
  ["computer-use", "'open Notepad'"],
  ["code-review", "'review this diff'"],
  ["debugging", "'my test fails'"],
  ["testing", "'add coverage'"],
  ["git-workflow", "'before I commit'"],
  ["web-research", "'search the web'"],
  ["project-init", "'set up a new project'"],
  ["browser-use", "'open the browser'"],
  ["focused-fix", "'fix this feature end-to-end'"],
  ["zero-hallucination", "'verify the real API'"],
  ["self-eval", "'am I finished?'"],
  ["ship-gate", "'commit and push'"],
  // R72-b: the six craft additions carry their own verbatim triggers.
  ["tdd", "'write the test first'"],
  ["api-design", "'add an endpoint'"],
  ["frontend-craft", "'fix the layout'"],
  ["typescript-craft", "'fix the any'"],
  ["security-review", "'is this safe'"],
  ["refactoring", "'clean this up'"],
  // R73-d: the two methodology additions carry their own verbatim triggers.
  ["spec-planning", "'write a spec'"],
  ["performance", "'make it faster'"],
  // ROUND-96 (R96-D): the four owner-named additions carry their own verbatim triggers.
  ["planning", "'work through this list'"],
  ["ui-design", "'this looks off'"],
  ["error-testing", "'it worked yesterday'"],
  ["large-project-navigation", "'where is X implemented'"],
];

/** The negative scope disambiguates the nearest adjacent skill. */
const NEGATIVE_SCOPES: ReadonlyArray<[name: string, notFor: string]> = [
  ["computer-use", "browser-use"],
  ["code-review", "debugging"],
  ["debugging", "focused-fix"],
  ["testing", "CI pipeline setup"],
  ["git-workflow", "code-review"],
  ["web-research", "search_code"],
  ["project-init", "exploring or answering questions about existing code"],
  ["browser-use", "computer-use"],
  ["focused-fix", "debugging"],
  ["zero-hallucination", "trivial edits"],
  ["self-eval", "code-review"],
  ["ship-gate", "infra provisioning"],
  // R72-b: the six craft additions disambiguate their nearest neighbors.
  ["tdd", "testing"],
  ["api-design", "GraphQL schemas"],
  ["frontend-craft", "backend logic"],
  ["typescript-craft", "build config"],
  ["security-review", "code-review"],
  ["refactoring", "debugging"],
  // R73-d: the two methodology additions disambiguate their nearest neighbors.
  ["spec-planning", "quick fixes"],
  ["performance", "code style"],
  // ROUND-96 (R96-D): the four owner-named additions disambiguate their nearest neighbors.
  ["planning", "spec-planning"],
  ["ui-design", "frontend-craft"],
  ["error-testing", "code-review"],
  ["large-project-navigation", "one-file edits"],
];

// ────────────────────────────────────────────────────────────────────────────
// D1 — trigger-rich descriptions for all twenty
// ─────────────────────────────────────────────────────────────────────────────

describe("R71-e3 D1: trigger-rich descriptions (the C1 fix)", () => {
  it("TWENTY-FOUR builtins seed in the fixed order with the fixed ids", () => {
    const builtins = listSkills(db).filter((s) => s.source === "builtin");
    expect(builtins.map((s) => s.name)).toEqual(EXPECTED_BUILTINS.map((b) => b.name));
    expect(builtins.map((s) => s.id)).toEqual(EXPECTED_BUILTINS.map((b) => b.id));
    expect(builtins.map((s) => s.sortOrder)).toEqual(EXPECTED_BUILTINS.map((b) => b.sortOrder));
    expect(builtins.every((s) => s.enabled)).toBe(true);
  });

  it.each(EXPECTED_BUILTINS)(
    "%s: description carries 'Use when' + 'NOT for' + a quoted trigger phrase, 300-500 chars",
    (expected) => {
      const skill = getSkill(db, expected.id);
      expect(skill).toBeDefined();
      const description = skill?.description ?? "";
      // The convention: trigger surface + negative scope (case-insensitive).
      expect(description).toMatch(/use when /i);
      expect(description).toMatch(/not for /i);
      // The storage cap holds (the DB slices at 500 — the seed must not need it).
      expect(description.length).toBeLessThanOrEqual(500);
      expect(description.length).toBeGreaterThanOrEqual(300);
      // Every description is trigger-rich: at least one verbatim quoted phrasing.
      expect(description).toMatch(/'[^']{3,}'/);
      // And it names what it delivers (the middle sentence of the convention).
      expect(description).toMatch(/delivers /i);
    },
  );

  it.each(TRIGGER_PHRASES)("%s: description contains the verbatim trigger phrase %s", (name, phrase) => {
    const skill = listSkills(db).find((s) => s.name === name);
    expect(skill?.description).toContain(phrase);
  });

  it.each(NEGATIVE_SCOPES)("%s: negative scope names the adjacent case (%s)", (name, notFor) => {
    const skill = listSkills(db).find((s) => s.name === name);
    expect(skill?.description).toMatch(new RegExp(`not for [^.]*(\\(|${notFor.replace(/[()]/g, "\\$&")})`, "i"));
  });

  it("the twenty-four descriptions are distinct (no copy-paste trigger surface)", () => {
    const descriptions = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => s.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(descriptions).toHaveLength(24);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D2 — the four R71-e3 built-in bodies (the C2 fix); the six R72-b
// additions and the two R73-d additions ride the same house-format
// contract (their own content pins live in tests/r72-skills-expansion.test.ts
// and tests/r73-skills-round.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

describe("R71-e3 D2: the four new built-in skills", () => {
  const NEW_BUILTINS: ReadonlyArray<[name: string, id: string]> = [
    ["focused-fix", "skill_builtin_focused_fix"],
    ["zero-hallucination", "skill_builtin_zero_hallucination"],
    ["self-eval", "skill_builtin_self_eval"],
    ["ship-gate", "skill_builtin_ship_gate"],
    // R72-b: the six craft additions ride the same house-format contract.
    ["tdd", "skill_builtin_tdd"],
    ["api-design", "skill_builtin_api_design"],
    ["frontend-craft", "skill_builtin_frontend_craft"],
    ["typescript-craft", "skill_builtin_typescript_craft"],
    ["security-review", "skill_builtin_security_review"],
    ["refactoring", "skill_builtin_refactoring"],
    // R73-d: the two methodology additions ride the same house-format contract.
    ["spec-planning", "skill_builtin_spec_planning"],
    ["performance", "skill_builtin_performance"],
  ];

  it.each(NEW_BUILTINS)(
    "%s: house-format body — '# Skill:' prefix, 1.0-1.9KB, <= 60 lines",
    (name, id) => {
      const skill = getSkill(db, id);
      expect(skill).toBeDefined();
      const body = skill?.body ?? "";
      expect(body.startsWith(`# Skill: ${name}`)).toBe(true);
      // The R71-d design band: ~1.2-1.8KB bodies (hard bounds 1.0-2.2KB).
      expect(body.length).toBeGreaterThanOrEqual(1_000);
      expect(body.length).toBeLessThanOrEqual(1_900);
      expect(body.trim().split("\n").length).toBeLessThanOrEqual(60);
    },
  );

  it("focused-fix: the Iron Law, the 3-step contract, 3-strike escalation, red flags, smallest-change rule", () => {
    const body = getSkill(db, "skill_builtin_focused_fix")?.body ?? "";
    // The iron law, verbatim and in caps.
    expect(body).toContain("NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST");
    // The 3-step contract: SCOPE / TRACE / DIAGNOSE with the exact disciplines.
    expect(body).toMatch(/1\. SCOPE — .*SYMPTOMS.*EXPECTED behavior/is);
    expect(body).toMatch(/2\. TRACE — .*reproduce.*read the real code/is);
    expect(body).toMatch(/NEVER fix from a guess/s);
    expect(body).toMatch(/3\. DIAGNOSE — .*ONE sentence BEFORE editing/s);
    // Pre-built output-format block.
    expect(body).toContain("SCOPE REPORT:");
    expect(body).toContain("TRACE:");
    expect(body).toContain("DIAGNOSIS:");
    // 3-Strike escalation.
    expect(body).toMatch(/3 failed fixes to the same problem = STOP/);
    expect(body).toMatch(/probably NOT where you are editing/);
    expect(body).toMatch(/(fix #4|fix #4)/i);
    // Red flags quoting the model's own excuses.
    expect(body).toContain(`"It's a small fix, no need to reproduce."`);
    expect(body).toContain(`"I'm sure it's this line."`);
    expect(body).toContain(`"I'll just try the change and see."`);
    // The fix rule: smallest change + verify with the step-1 reproduction.
    expect(body).toMatch(/SMALLEST change that fixes the diagnosed cause/);
    expect(body).toMatch(/reproduction from SCOPE/);
    // ACUTE's real tools are named.
    expect(body).toContain("run_command");
    expect(body).toContain("read_file");
    expect(body).toContain("search_code");
    expect(body).toContain("edit_file");
  });

  it("zero-hallucination: KNOWN/ASSUMED/UNKNOWN tags, the UNKNOWN ban, the 6-rung YAGNI ladder, source-wins rules", () => {
    const body = getSkill(db, "skill_builtin_zero_hallucination")?.body ?? "";
    // Evidence tags.
    expect(body).toContain("[KNOWN]");
    expect(body).toContain("[ASSUMED]");
    expect(body).toContain("[UNKNOWN]");
    // The hard rule, in caps.
    expect(body).toContain("NEVER WRITE CODE THAT DEPENDS ON AN [UNKNOWN]");
    // The resolution path uses ACUTE's real tools.
    expect(body).toMatch(/read_file or search_code/);
    // The YAGNI ladder: the mantra + six numbered rungs.
    expect(body).toContain("the best code is the code you never wrote");
    expect(body).toMatch(/The 6-rung YAGNI ladder/);
    expect(body).toMatch(/1\. Does this code need to exist at all/);
    expect(body).toMatch(/2\. Does the stdlib \/ language itself already do it/);
    expect(body).toMatch(/4\. Does an ALREADY-INSTALLED dependency do it/);
    expect(body).toMatch(/6\. Write the minimum that works/);
    // The never-on-the-chopping-block carve-out.
    expect(body).toContain("Never on the chopping block");
    // Anti-hallucination precedence rules.
    expect(body).toMatch(/Never invent imports, flags, paths, or option names/);
    expect(body).toContain("the SOURCE wins");
    expect(body).toContain("the REPRODUCTION wins");
  });

  it("self-eval: the matrix (locked), the cap, devil's advocate, receipts, confidence tags, the checklist, VERDICT block", () => {
    const body = getSkill(db, "skill_builtin_self_eval")?.body ?? "";
    // Two axes, 0-3, with the exact semantics.
    expect(body).toMatch(/AMBITION — how completely the request is solved/);
    expect(body).toMatch(/EXECUTION — verified-by-receipts quality/);
    // Matrix-locked: read it, don't override it; low ambition caps at 2.
    expect(body).toContain("READ THE MATRIX, don't override it");
    expect(body).toContain("LOW AMBITION CAPS THE TOTAL AT 2");
    expect(body).toMatch(/A 5 requires complete ambition AND receipted execution/);
    // Anti-grade-inflation.
    expect(body).toMatch(/A claim without a receipt scores 0/i);
    // The confidence tags match the evidence (the only emoji allowed).
    expect(body).toContain("🟢");
    expect(body).toContain("🟡");
    expect(body).toContain("🔴");
    expect(body).toMatch(/confidence tag must MATCH the evidence/);
    // Mandatory devil's advocate.
    expect(body).toMatch(/Mandatory devil's advocate/i);
    expect(body).toMatch(/strongest counter-argument/i);
    // The checklist.
    expect(body).toContain("todo_write");
    expect(body).toMatch(/Zero scope creep/);
    expect(body).toMatch(/Campsite clean/);
    // The pre-built output-format block.
    expect(body).toContain("VERDICT:");
    expect(body).toContain("DEVIL'S ADVOCATE:");
    expect(body).toContain("CONFIDENCE:");
    expect(body).toContain("GAPS:");
  });

  it("ship-gate: intercepts ship intent, CRITICAL/HIGH/ADVISORY tiers, the three verdicts, receipts-required, GATE REPORT", () => {
    const body = getSkill(db, "skill_builtin_ship_gate")?.body ?? "";
    // The interception phrases.
    expect(body).toMatch(/Intercept every ship moment/);
    for (const phrase of [`"done"`, `"ship it"`, `"commit and push"`, `"deploy"`, `"release"`, `"go live"`]) {
      expect(body).toContain(phrase);
    }
    // CRITICAL tier with the exact checks.
    expect(body).toMatch(/## CRITICAL — any failure = DO NOT SHIP/);
    expect(body).toMatch(/ACTUALLY RUN and green/i);
    expect(body).toMatch(/quote the command \+ exit code/);
    expect(body).toMatch(/Build compiles/);
    expect(body).toMatch(/No secrets or tokens/);
    // HIGH tier: every hunk traces to the request.
    expect(body).toMatch(/## HIGH — fix, or list explicitly/);
    expect(body).toMatch(/every hunk traces to the request/);
    expect(body).toContain("todo_write");
    // ADVISORY tier.
    expect(body).toMatch(/## ADVISORY — note, don't block/);
    expect(body).toMatch(/Version bump/);
    expect(body).toMatch(/Changelog/);
    // The three verdicts + the receipts rule.
    expect(body).toContain("DO NOT SHIP");
    expect(body).toContain("SHIP WITH NOTES");
    expect(body).toContain("CLEAR");
    expect(body).toContain("NEVER claim SHIP on assertion alone");
    // The pre-built output-format block.
    expect(body).toContain("GATE REPORT");
    // ACUTE's real tools.
    expect(body).toContain("run_command");
    expect(body).toContain("git_diff");
    expect(body).toContain("git_status");
  });

  it("emoji discipline: 🟢🟡🔴 live ONLY in self-eval; the other new bodies carry no emoji", () => {
    const bodies = new Map(
      listSkills(db)
        .filter((s) => s.source === "builtin")
        .map((s) => [s.name, s.body]),
    );
    for (const name of [
      "focused-fix",
      "zero-hallucination",
      "ship-gate",
      // R72-b: the six craft additions carry no emoji either.
      "tdd",
      "api-design",
      "frontend-craft",
      "typescript-craft",
      "security-review",
      "refactoring",
      // R73-d: the two methodology additions carry no emoji either.
      "spec-planning",
      "performance",
    ]) {
      expect(bodies.get(name)).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    // And self-eval's only pictographs are the three confidence circles.
    const selfEvalEmoji = [...(bodies.get("self-eval") ?? "")].filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
    expect(new Set(selfEvalEmoji)).toEqual(new Set(["🟢", "🟡", "🔴"]));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D3 — the INSERT OR IGNORE contract, twenty-strong (R72-b + R73-d re-pins)
// ─────────────────────────────────────────────────────────────────────────────

describe("R71-e3 D3: INSERT OR IGNORE with 24 builtins", () => {
  it("an explicit re-seed is idempotent: still exactly 20 rows, unique names, unique ids", () => {
    seedBuiltinSkills(db);
    seedBuiltinSkills(db);
    const rows = db.prepare("SELECT * FROM skills").all() as Array<{ id: string; name: string; source: string }>;
    const builtins = rows.filter((r) => r.source === "builtin");
    expect(builtins).toHaveLength(24);
    expect(new Set(builtins.map((r) => r.id)).size).toBe(24);
    expect(new Set(builtins.map((r) => r.name)).size).toBe(24);
  });

  it("a deleted NEW builtin row revives on reopen (an existing pre-R73 DB converges on 20)", () => {
    const path = join(tempDir, "converge.db");
    const existing = openDatabase(path); // an "existing user DB" — already seeded
    try {
      // The user nukes rows from the R71, R72, and R73 generations (say, by hand).
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_focused_fix");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_ship_gate");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_tdd");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_spec_planning");
      existing.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_planning");
      expect(listSkills(existing).filter((s) => s.source === "builtin")).toHaveLength(19);
    } finally {
      existing.close();
    }
    // Next open: the seeding at open recreates the missing rows.
    const reopened = openDatabase(path);
    try {
      const builtins = listSkills(reopened).filter((s) => s.source === "builtin");
      expect(builtins).toHaveLength(24);
      expect(getSkill(reopened, "skill_builtin_focused_fix")?.name).toBe("focused-fix");
      expect(getSkill(reopened, "skill_builtin_focused_fix")?.body).toContain("NO FIXES WITHOUT COMPLETING");
      expect(getSkill(reopened, "skill_builtin_ship_gate")?.body).toContain("GATE REPORT");
      expect(getSkill(reopened, "skill_builtin_tdd")?.body).toContain("NEVER WRITE THE TEST AFTER THE CODE");
      expect(getSkill(reopened, "skill_builtin_spec_planning")?.body).toContain("DECISION DOCUMENT");
    } finally {
      reopened.close();
    }
  });

  it("user edits to the new builtins persist across reseeds (the R70 contract, unchanged)", () => {
    updateSkill(db, "skill_builtin_self_eval", { body: "MY SELF-EVAL EDIT" });
    updateSkill(db, "skill_builtin_tdd", { body: "MY TDD EDIT" });
    updateSkill(db, "skill_builtin_performance", { body: "MY PERFORMANCE EDIT" });
    seedBuiltinSkills(db);
    expect(getSkill(db, "skill_builtin_self_eval")?.body).toBe("MY SELF-EVAL EDIT");
    expect(getSkill(db, "skill_builtin_tdd")?.body).toBe("MY TDD EDIT");
    expect(getSkill(db, "skill_builtin_performance")?.body).toBe("MY PERFORMANCE EDIT");
    // And the edits did not duplicate the rows.
    expect(listSkills(db).filter((s) => s.name === "self-eval")).toHaveLength(1);
    expect(listSkills(db).filter((s) => s.name === "tdd")).toHaveLength(1);
    expect(listSkills(db).filter((s) => s.name === "performance")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — the descriptions flow into the prompt SKILLS section (ctx-driven)
// ─────────────────────────────────────────────────────────────────────────────

describe("R71-e3 D4: descriptions ride the prompt SKILLS section verbatim", () => {
  function promptCtx(skills: ReadonlyArray<{ name: string; description: string }>): PromptContext {
    return {
      projectName: "R71e3Project",
      rootPath: join(tempDir, "never-exists"),
      toolNames: [],
      maxTurns: 40,
      maxOuterLoops: 5,
      skills,
    };
  }

  it("all twenty-four builtins render as '- **name** — description' with the FULL new descriptions", () => {
    const builtins = listSkills(db)
      .filter((s) => s.source === "builtin")
      .map((s) => ({ name: s.name, description: s.description }));
    expect(builtins).toHaveLength(24);

    const section = buildSectionText(promptCtx(builtins), "skills") ?? "";
    expect(section).toContain("## SKILLS (load with read_skill, search with search_skills)");
    expect(section).toContain("call read_skill with its name FIRST");
    for (const skill of builtins) {
      expect(section).toContain(`- **${skill.name}** — ${skill.description}`);
    }
    // The trigger surface is what the model sees: the phrase-level proof.
    expect(section).toContain("'my test fails'");
    expect(section).toContain("'review this diff'");
    expect(section).toContain("NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST");
    expect(section).toContain("DO NOT SHIP / SHIP WITH NOTES / CLEAR");
    // R72-b: the six craft phrases ride the same surface.
    expect(section).toContain("'write the test first'");
    expect(section).toContain("'is this safe'");
    // R73-d: the two methodology phrases ride the same surface.
    expect(section).toContain("'write a spec'");
    expect(section).toContain("'make it faster'");
    // The reload affordance still rides the section (R70-c D6).
    expect(section).toContain("A skill body that appears truncated after context compaction can be RELOADED: call read_skill again.");
  });
});
