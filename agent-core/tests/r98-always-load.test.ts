/**
 * ROUND-98 (R98-E2): the ALWAYS-LOAD SKILLS tier — the owner: "there are
 * some skills which it must follow every single time, every single
 * session" (the webpage-design failure: ui-design/frontend-craft were
 * one-line index entries the model never read).
 *
 * Pins in this file:
 *   1. STORAGE — migration 0037's default (every seed row unpinned), the
 *      CRUD round-trip (create/patch alwaysLoad), the file-side frontmatter
 *      (`always-load: true`), the resolver surfacing alwaysLoad + FULL body
 *      for pinned rows/files, and the DB-shadows-file rule covering the pin.
 *   2. PROMPT — the "## ALWAYS-ON SKILLS" section composes the pinned FULL
 *      bodies; the 24,000-char total budget truncates HONESTLY (the marker
 *      names the skill + both counts; later pins get the omitted line);
 *      ZERO pinned → NO section and byte-identical composition (the
 *      old-shape ctx — plain {name, description} entries — composes the
 *      exact same bytes as a new-shape ctx with no flags set).
 *   3. HINTS — the deterministic STRONG phrasing boundary (score ≥ 15).
 *   4. ROUTES — PATCH /skills/:id {alwaysLoad} (the SkillsTab switch) and
 *      GET /skills surfacing the flag.
 *
 * The GOLDEN re-pin for the tier lives in prompt-registry.test.ts (FULL_CTX
 * gained one pinned skill so the fixture byte-pins the section; the
 * regeneration note + the verified diff are documented there).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  createSkill,
  getSkill,
  listSkills,
  updateSkill,
  COMPUTER_USE_SKILL_ID,
} from "../src/storage/skills";
import {
  discoverProjectFileSkills,
  listAllSkillsMerged,
  readFileSkillBody,
  resolveEffectiveSkills,
} from "../src/storage/skills-files";
import {
  ALWAYS_ON_SKILLS_CHAR_BUDGET,
  buildProjectSystemPrompt,
  describePromptSections,
  type PromptContext,
} from "../src/agents/prompts";
import { computeTaskHints } from "../src/agents/task-hints";
import { ProviderKeyring } from "../src/providers/registry";
import { buildServer } from "../src/server";
import { createProject } from "../src/storage/projects";

let tempDir = "";
let db: SqliteDatabase;

const TOKEN = "test-token-r98e2";
const KEY = "sk-or-vtest-r98e2";

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98e2-"));
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

/* ── 1. storage ───────────────────────────────────────────────────────────── */

describe("R98-E2: the always_load column + CRUD", () => {
  it("migration 0037 defaults every seeded row to UNPINNED (nothing rides until the owner opts in)", () => {
    for (const skill of listSkills(db)) {
      expect(skill.alwaysLoad).toBe(false);
    }
    // The motivating builtin exists and is unpinned.
    expect(getSkill(db, COMPUTER_USE_SKILL_ID)?.alwaysLoad).toBe(false);
  });

  it("the CRUD round-trip: create pinned, patch un-pinned, re-pin — always reflected", () => {
    const created = createSkill(db, {
      name: "house-style",
      description: "The project's house style.",
      body: "# Skill: house-style\n\nAlways pnpm. Always tests.",
      alwaysLoad: true,
    });
    expect(created.alwaysLoad).toBe(true);

    const unpinned = updateSkill(db, created.id, { alwaysLoad: false });
    expect(unpinned?.alwaysLoad).toBe(false);
    expect(getSkill(db, created.id)?.alwaysLoad).toBe(false);

    const repinned = updateSkill(db, created.id, { alwaysLoad: true });
    expect(repinned?.alwaysLoad).toBe(true);
    // The pinned builtin the owner actually wants to pin (the motivating
    // case): patching a BUILTIN row works exactly like a user row.
    const ui = listSkills(db).find((s) => s.name === "ui-design");
    expect(ui).toBeDefined();
    const pinnedBuiltin = updateSkill(db, ui!.id, { alwaysLoad: true });
    expect(pinnedBuiltin?.alwaysLoad).toBe(true);
  });
});

describe("R98-E2: file-skill frontmatter `always-load: true`", () => {
  it("parses into the same tier (exact lowercase spelling; anything else is false)", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98e2f-"));
    try {
      const skillsDir = join(root, ".acute", "skills");
      mkdirSync(join(skillsDir, "pinned-flow"), { recursive: true });
      writeFileSync(
        join(skillsDir, "pinned-flow", "SKILL.md"),
        "---\nname: pinned-flow\ndescription: a pinned file skill\nalways-load: true\n---\n# Skill: pinned-flow\n\nFile body.",
      );
      mkdirSync(join(skillsDir, "plain-flow"), { recursive: true });
      writeFileSync(
        join(skillsDir, "plain-flow", "SKILL.md"),
        "---\nname: plain-flow\ndescription: not pinned\nalways-load: false\n---\n# Skill: plain-flow\n\nBody.",
      );
      mkdirSync(join(skillsDir, "weird-flow"), { recursive: true });
      writeFileSync(
        join(skillsDir, "weird-flow", "SKILL.md"),
        "---\nname: weird-flow\ndescription: misspelled flag\nAlways-Load: TRUE\n---\n# Skill: weird-flow\n\nBody.",
      );

      const found = discoverProjectFileSkills(root, "proj-98e2");
      expect(found.find((s) => s.name === "pinned-flow")?.alwaysLoad).toBe(true);
      expect(found.find((s) => s.name === "plain-flow")?.alwaysLoad).toBe(false);
      // Case-sensitive key + exact "true" value — fail-soft like the rest of
      // the frontmatter tolerances.
      expect(found.find((s) => s.name === "weird-flow")?.alwaysLoad).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R98-E2: resolveEffectiveSkills surfaces the pin + the FULL body", () => {
  it("a pinned DB row carries alwaysLoad + the row's body — the exact text read_skill returns", () => {
    createSkill(db, {
      name: "house-style",
      description: "The project's house style.",
      body: "# Skill: house-style\n\nAlways pnpm.",
      alwaysLoad: true,
    });
    const effective = resolveEffectiveSkills(db, {});
    const house = effective.find((s) => s.name === "house-style");
    expect(house?.alwaysLoad).toBe(true);
    expect(house?.body).toBe("# Skill: house-style\n\nAlways pnpm.");
    // Unpinned entries keep the pre-R98 shape (no alwaysLoad/body fields).
    const plain = effective.find((s) => s.name === "code-review");
    expect(plain?.alwaysLoad).toBeUndefined();
    expect(plain?.body).toBeUndefined();
  });

  it("a pinned FILE skill carries the body read from disk at resolve time (the read_skill source)", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98e2r-"));
    try {
      mkdirSync(join(root, ".acute", "skills", "deploy-pinned"), { recursive: true });
      writeFileSync(
        join(root, ".acute", "skills", "deploy-pinned", "SKILL.md"),
        "---\nname: deploy-pinned\ndescription: pinned deploy flow\nalways-load: true\n---\n# Skill: deploy-pinned\n\nDeploy body.",
      );
      const effective = resolveEffectiveSkills(db, { projectRoot: root });
      const deploy = effective.find((s) => s.name === "deploy-pinned");
      expect(deploy?.alwaysLoad).toBe(true);
      expect(deploy?.body).toBe("# Skill: deploy-pinned\n\nDeploy body.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the DB-shadows-file rule covers the PIN: a same-name DB row (pinned or not) wins the flag", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98e2s-"));
    try {
      mkdirSync(join(root, ".acute", "skills", "shared-pin"), { recursive: true });
      writeFileSync(
        join(root, ".acute", "skills", "shared-pin", "SKILL.md"),
        "---\nname: shared-pin\ndescription: file pin\nalways-load: true\n---\n# Skill: shared-pin\n\nFile body.",
      );
      // No DB row → the file's pin is live.
      expect(resolveEffectiveSkills(db, { projectRoot: root }).find((s) => s.name === "shared-pin")?.alwaysLoad).toBe(
        true,
      );
      // An UNPINNED DB row of the same name SHADOWS the file — the pin does
      // not fall through (disabling an override must not resurrect it).
      createSkill(db, { name: "shared-pin", description: "db version", body: "db body" });
      const shadowed = resolveEffectiveSkills(db, { projectRoot: root }).find((s) => s.name === "shared-pin");
      expect(shadowed?.alwaysLoad).toBeUndefined();
      expect(shadowed?.body).toBeUndefined();
      // A PINNED DB row shadows with its own body (the documented override path).
      const row = listSkills(db).find((s) => s.name === "shared-pin");
      updateSkill(db, row!.id, { alwaysLoad: true });
      const overridden = resolveEffectiveSkills(db, { projectRoot: root }).find((s) => s.name === "shared-pin");
      expect(overridden?.alwaysLoad).toBe(true);
      expect(overridden?.body).toBe("db body");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a pinned file skill whose file VANISHED degrades to the honest failure note, never silence", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98e2v-"));
    try {
      mkdirSync(join(root, ".acute", "skills"), { recursive: true });
      const file = join(root, ".acute", "skills", "gone-pin.md");
      writeFileSync(
        file,
        "---\nname: gone-pin\ndescription: will vanish\nalways-load: true\n---\n# Skill: gone-pin\n\nBody.",
      );
      // The discovery path reads the file for listing; simulate the
      // vanished-between-listing-and-load race directly on the body reader
      // the resolver uses.
      const before = readFileSkillBody(file);
      expect(before.ok).toBe(true);
      rmSync(file);
      const after = readFileSkillBody(file);
      expect(after.ok).toBe(false);
      if (!after.ok) {
        expect(after.note).toContain("no longer exists");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R98-E2: GET /skills listing surfaces the flag (the Settings switch rides it)", () => {
  it("DB rows and file rows both carry alwaysLoad", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98e2m-"));
    try {
      createSkill(db, { name: "house-style", description: "house", body: "b", alwaysLoad: true });
      createProject(db, { name: "R98E2 Project", rootPath: root });
      mkdirSync(join(root, ".acute", "skills", "file-pin"), { recursive: true });
      writeFileSync(
        join(root, ".acute", "skills", "file-pin", "SKILL.md"),
        "---\nname: file-pin\ndescription: fp\nalways-load: true\n---\nBody.",
      );
      const merged = listAllSkillsMerged(db);
      expect(merged.find((s) => s.name === "house-style")?.alwaysLoad).toBe(true);
      expect(merged.find((s) => s.name === "file-pin")?.alwaysLoad).toBe(true);
      expect(merged.find((s) => s.name === "code-review")?.alwaysLoad).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ── 2. the prompt composition ────────────────────────────────────────────── */

/** A hermetic ctx: a root that never exists (no overrides), a tiny tool set. */
function ctxFor(skills: PromptContext["skills"]): PromptContext {
  return {
    projectName: "R98E2Project",
    rootPath: "/tmp/acute-r98e2-never-exists",
    toolNames: ["read_file", "read_skill", "search_skills"],
    skills,
  };
}

describe("R98-E2: the ALWAYS-ON SKILLS section", () => {
  const BODY_A = "# Skill: house-style\n\nR98E2-BODY-A — always pnpm, always tests.";

  it("composes the pinned FULL bodies directly after the SKILLS index; the index line carries the ALWAYS-ON marker", () => {
    const prompt = buildProjectSystemPrompt(
      ctxFor([
        { name: "house-style", description: "The house style.", alwaysLoad: true, body: BODY_A },
        { name: "plain", description: "not pinned" },
      ]),
    );
    expect(prompt).toContain("## ALWAYS-ON SKILLS (pinned — full bodies ride every turn)");
    expect(prompt).toContain("The owner pinned these skills: their FULL bodies are already below");
    expect(prompt).toContain("### Skill: house-style");
    expect(prompt).toContain(BODY_A);
    // The index marks the pinned entry.
    expect(prompt).toContain(
      "- **house-style** — The house style. (ALWAYS-ON — full body in the ALWAYS-ON SKILLS section below)",
    );
    expect(prompt).not.toContain("- **plain** — not pinned. (ALWAYS-ON");
    // Order: the ALWAYS-ON section rides BETWEEN the skills index and the
    // next section (there is none here — the tail is ENVIRONMENT).
    expect(prompt.indexOf("## ALWAYS-ON SKILLS")).toBeGreaterThan(prompt.indexOf("## SKILLS (load with read_skill"));
    expect(prompt.indexOf("## ENVIRONMENT")).toBeGreaterThan(prompt.indexOf("### Skill: house-style"));
    // The registry report agrees (the section is present, in order).
    const report = describePromptSections(
      ctxFor([{ name: "house-style", description: "The house style.", alwaysLoad: true, body: BODY_A }]),
    );
    expect(report.effectiveOrder.indexOf("always-on-skills")).toBe(report.effectiveOrder.indexOf("skills") + 1);
  });

  it("the 24,000-char TOTAL budget truncates honestly: the crossing body gets the marker, later pins the omitted line", () => {
    const bigA = `A`.repeat(20_000);
    const bigB = `B`.repeat(9_000); // 20,000 + 9,000 > 24,000 → B crosses
    const bigC = `C`.repeat(50);
    const prompt = buildProjectSystemPrompt(
      ctxFor([
        { name: "big-a", description: "a", alwaysLoad: true, body: bigA },
        { name: "big-b", description: "b", alwaysLoad: true, body: bigB },
        { name: "big-c", description: "c", alwaysLoad: true, body: bigC },
      ]),
    );
    // A rides whole.
    expect(prompt).toContain(bigA);
    // B is truncated to the remainder with the honest marker naming it.
    expect(prompt).not.toContain(bigB);
    expect(prompt).toContain(
      "…[always-on budget: big-b truncated at 4,000 of 9,000 chars — the 24,000-char always-on budget is exhausted; read_skill loads the full body]",
    );
    // C never lands — the honest omitted line instead.
    expect(prompt).not.toContain(bigC);
    expect(prompt).toContain(
      "- **big-c** — omitted: the 24,000-char always-on budget is exhausted (load it with read_skill).",
    );
    // The budget constant itself is pinned (the Settings readout rides it).
    expect(ALWAYS_ON_SKILLS_CHAR_BUDGET).toBe(24_000);
  });

  it("ZERO pinned → NO section, and the new-shape ctx (fields unset) is byte-identical to the old-shape ctx", () => {
    // Old shape: plain {name, description} entries (the pre-R98 caller).
    const oldShape = ctxFor([
      { name: "plain-a", description: "one" },
      { name: "plain-b", description: "two" },
    ]);
    // New shape: same entries with the tier fields explicitly absent.
    const newShape = ctxFor([
      { name: "plain-a", description: "one" },
      { name: "plain-b", description: "two" },
    ]);
    expect(buildProjectSystemPrompt(newShape)).toBe(buildProjectSystemPrompt(oldShape));
    const composed = buildProjectSystemPrompt(oldShape);
    expect(composed).not.toContain("ALWAYS-ON");
    expect(composed).not.toContain("### Skill:");
    // And no ctx.skills at all → no SKILLS and no ALWAYS-ON section.
    const bare = buildProjectSystemPrompt(ctxFor(undefined));
    expect(bare).not.toContain("## SKILLS (load with read_skill");
    expect(bare).not.toContain("ALWAYS-ON");
  });

  it("an alwaysLoad flag without a body composes the section honestly (empty body, still pinned)", () => {
    const prompt = buildProjectSystemPrompt(
      ctxFor([{ name: "no-body", description: "pinned but bodyless", alwaysLoad: true }]),
    );
    expect(prompt).toContain("### Skill: no-body");
    expect(prompt).toContain("## ENVIRONMENT"); // the composition stays well-formed
    expect(prompt).not.toMatch(/\n\n\n/); // no blank-line pileup
  });
});

/* ── 3. the hint phrasing boundary ─────────────────────────────────────────── */

describe("R98-E2: the STRONG task-hint phrasing (deterministic — keyed on the score)", () => {
  it("score ≥ 15 → 'read it BEFORE starting'; score < 15 → the exact R72 wording", () => {
    const skills = [
      { name: "strong-skill", description: "Use when the user says 'deploy the production service now' — deploys." },
      { name: "weak-skill", description: "Use when the user says 'this bug' — fixes defects." },
    ];
    // 'deploy the production service now' = 5-word verbatim phrase = 25.
    const hints = computeTaskHints("please deploy the production service now", skills);
    expect(hints[0]?.skillName).toBe("strong-skill");
    expect(hints[0]!.score).toBeGreaterThanOrEqual(15);

    // prepareTurn threads the computed hints into the ctx — the same shape.
    const strong = buildProjectSystemPrompt({ ...ctxFor(skills), taskHints: hints });
    expect(strong).toContain(
      "Task signal: this request strongly matches **strong-skill** — read it before starting (read_skill with that name) and follow it for the rest of the task.",
    );

    // 'this bug' = 2-word phrase = 10 + token hits — BELOW the 15 floor.
    const weakHints = computeTaskHints("hey look at this bug when you can", skills);
    expect(weakHints[0]?.skillName).toBe("weak-skill");
    expect(weakHints[0]!.score).toBeLessThan(15);
    const weak = buildProjectSystemPrompt({
      ...ctxFor(skills),
      taskHints: [{ skillName: "weak-skill", score: weakHints[0]?.score ?? 0 }],
    });
    expect(weak).toContain(
      "Task signal: this request looks like it matches **weak-skill** — consider calling read_skill with that name first and following it for the rest of the task.",
    );
    expect(weak).not.toContain("strongly matches");
  });

  it("the two-hint STRONG variant keeps the '(and possibly …)' parenthetical", () => {
    const prompt = buildProjectSystemPrompt({
      ...ctxFor([{ name: "a", description: "x" }]),
      taskHints: [
        { skillName: "strong-skill", score: 25 },
        { skillName: "second", score: 8 },
      ],
    });
    expect(prompt).toContain(
      "Task signal: this request strongly matches **strong-skill** (and possibly **second**) — read it before starting (read_skill with that name) and follow it for the rest of the task.",
    );
  });
});

/* ── 4. routes (the SkillsTab switch's path) ──────────────────────────────── */

describe("R98-E2: routes — PATCH /skills/:id {alwaysLoad} + GET /skills flag", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function authInject(options: {
    method: "GET" | "PATCH" | "PUT" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse> {
    return (await app.inject({
      ...options,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
  }

  it("PATCH {alwaysLoad:true} pins a builtin (the owner's motivating action) and GET /skills reflects it", async () => {
    const ui = listSkills(db).find((s) => s.name === "ui-design");
    expect(ui).toBeDefined();
    const patch = await authInject({ method: "PATCH", url: `/api/v1/skills/${ui!.id}`, payload: { alwaysLoad: true } });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { alwaysLoad: boolean }).alwaysLoad).toBe(true);

    const list = await authInject({ method: "GET", url: "/api/v1/skills" });
    const rows = (list.json() as { skills: Array<{ name: string; alwaysLoad: boolean }> }).skills;
    expect(rows.find((s) => s.name === "ui-design")?.alwaysLoad).toBe(true);
    expect(rows.find((s) => s.name === "code-review")?.alwaysLoad).toBe(false);
  });

  it("a pinned skill resolves through the FULL stack: PATCH → resolver → ALWAYS-ON body in the composed prompt", async () => {
    const created = createSkill(db, {
      name: "stack-check",
      description: "The full-stack pin check.",
      body: "R98E2-STACK-CHECK-BODY",
    });
    const patch = await authInject({
      method: "PATCH",
      url: `/api/v1/skills/${created.id}`,
      payload: { alwaysLoad: true },
    });
    expect(patch.statusCode).toBe(200);

    const effective = resolveEffectiveSkills(db, {});
    const stack = effective.find((s) => s.name === "stack-check");
    expect(stack?.alwaysLoad).toBe(true);
    expect(stack?.body).toBe("R98E2-STACK-CHECK-BODY");

    // The runtime's exact threading shape (runtime.ts R98-E2 map).
    const prompt = buildProjectSystemPrompt({
      ...ctxFor(
        effective.map((s) => ({
          name: s.name,
          description: s.description,
          ...(s.alwaysLoad === true
            ? { alwaysLoad: true, ...(s.body !== undefined ? { body: s.body } : {}) }
            : {}),
        })),
      ),
    });
    expect(prompt).toContain("## ALWAYS-ON SKILLS (pinned — full bodies ride every turn)");
    expect(prompt).toContain("R98E2-STACK-CHECK-BODY");
  });
});
