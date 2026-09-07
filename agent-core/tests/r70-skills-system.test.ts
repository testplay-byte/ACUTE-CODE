/**
 * ROUND-70 (R70-b) — the SKILLS SYSTEM round:
 *
 *   D1 — FILE-BASED SKILLS DISCOVERY (the Agent-Skills standard, R70-B
 *        recommendation #5): project .acute/skills/ + user-global
 *        ~/.agents/skills/, frontmatter parsing, merge precedence (DB row >
 *        project file > global file; file skills read-only), body loading
 *        from disk at CALL time, the merged GET /skills listing, and the
 *        honest 409 refusals on file-skill PATCH/DELETE.
 *   D2 — the SEVEN new built-in skills (R70-B recommendation #4) seeded
 *        with the INSERT OR IGNORE contract.
 *   D3 — STICKY SKILL BODIES: read_skill + memory_recall results survive
 *        the R58 replay capping (no 200-char stub, no head+tail mangling).
 *   D4 — COMPUTER-USE GATING: the builtin computer-use skill is hidden from
 *        the index and refused by read_skill while the master switch is off.
 *   D5 — agent.skills WIRED: a non-empty allowlist filters the skill set by
 *        name (prompt + read_skill agree — one shared resolver).
 *
 * ROUND-71 (R71-e3) RE-PINS: the builtin family grew 8 → 12 (focused-fix,
 * zero-hallucination, self-eval, ship-gate — see tests/r71-skills-round.test.ts
 * for the new skills' own pins). The R70-b pins below stay intact for the
 * original seven; the counts/orders updated honestly.
 *
 * ROUND-72 (R72-b) RE-PINS: the builtin family grew 12 → 18 (tdd,
 * api-design, frontend-craft, typescript-craft, security-review,
 * refactoring — see tests/r72-skills-expansion.test.ts for the six new
 * skills' own pins). The R70-b/R71-e3 pins below stay intact for the
 * original eleven; the counts/orders updated honestly to eighteen.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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
  seedBuiltinSkills,
  updateSkill,
} from "../src/storage/skills";
import {
  discoverFileSkills,
  discoverGlobalFileSkills,
  discoverProjectFileSkills,
  fileSkillId,
  FILE_SKILL_BODY_CAP,
  FILE_SKILL_DESC_CAP,
  FILE_SKILLS_PER_SOURCE_CAP,
  isFileSkillId,
  listAllSkillsMerged,
  parseSkillFrontmatter,
  readFileSkillBody,
  resolveEffectiveSkills,
  stripSkillFrontmatter,
} from "../src/storage/skills-files";
import { setComputerUseSettings } from "../src/storage/computer-use";
import { createProject } from "../src/storage/projects";
import { createAgent, updateAgent } from "../src/storage/agents";
import { createSession, appendSessionEvent } from "../src/storage/sessions";
import { skillsPlugin } from "../src/tools/plugins/skills";
import type { ToolDeps } from "../src/tools/index";
import type { ToolDefinition } from "../src/tools/registry";
import { assembleHistory, runStreamedAgentTurn } from "../src/agents/runtime";
import { isStickyResultTool, summarizeToolOutput } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { buildServer } from "../src/server";
import type { StreamChatEvent } from "../src/agents/chat";

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const TOKEN = "test-token-r70b";
const KEY = "sk-or-vtest-r70b";

let db: SqliteDatabase;
let tempDir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r70b-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

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

/** A user-global skills root (the ~/.agents/skills stand-in for tests). */
function globalRootWith(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tempDir, "global-"));
  for (const [name, content] of Object.entries(skills)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }
  return root;
}

/** The read_skill tool built for a db + (optional) agent + project root. */
function buildReadSkill(root: string, agentId: string) {
  const toolDeps = { db, sessionId: "sess_r70b", agentId } as ToolDeps;
  const tools = skillsPlugin.createTools({ root, toolDeps }) as ToolDefinition[];
  expect(tools.map((t) => t.name)).toEqual(["read_skill"]);
  return tools[0]!;
}

const FRONTMATTER_SKILL = `---
name: deploy-flow
description: How this project ships: tags, changelog, and the release checklist.
---
# Deploy flow

1. Run the tests.
2. Tag the release.`;

// ─────────────────────────────────────────────────────────────────────────────
// D1 — discovery + frontmatter + precedence + caps
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D1: file-based skill discovery", () => {
  it("discovers <root>/.acute/skills/<name>/SKILL.md with frontmatter (name + description)", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const skills = discoverProjectFileSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("deploy-flow");
    expect(skills[0]?.description).toBe("How this project ships: tags, changelog, and the release checklist.");
    expect(skills[0]?.source).toBe("project-file");
    expect(skills[0]?.filePath).toBe(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"));
  });

  it("discovers flat <name>.md files too; the dir form wins on a same-name collision", () => {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const dir = join(root, ".acute", "skills");
    mkdirSync(join(dir, "flat-skill"), { recursive: true });
    writeFileSync(join(dir, "flat-skill", "SKILL.md"), "---\nname: flat-skill\ndescription: the dir form\n---\ndir body", "utf8");
    writeFileSync(join(dir, "flat-skill.md"), "---\nname: flat-skill\ndescription: the flat form\n---\nflat body", "utf8");
    writeFileSync(join(dir, "only-flat.md"), "---\nname: only-flat\ndescription: just a file\n---\nflat only", "utf8");

    const skills = discoverProjectFileSkills(root);
    expect(skills.map((s) => s.name).sort()).toEqual(["flat-skill", "only-flat"]);
    // The dir form's content won the same-name collision.
    expect(skills.find((s) => s.name === "flat-skill")?.description).toBe("the dir form");
  });

  it("missing frontmatter → name from the slug + a generic description (tolerant)", () => {
    const root = projectRootWith({ plain: "# Just markdown\n\nNo frontmatter at all." });
    const skills = discoverProjectFileSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("plain");
    expect(skills[0]?.description).toContain("Project skill defined by a SKILL.md");
  });

  it("frontmatter name (valid slug) WINS over the dir name; invalid frontmatter name falls back to the slug", () => {
    const root = projectRootWith({
      container: `---\nname: real-name\ndescription: named by frontmatter\n---\nbody`,
      "good-slug": `---\nname: "Not A Slug"\ndescription: fallback case\n---\nbody`,
    });
    const skills = discoverProjectFileSkills(root);
    expect(skills.map((s) => s.name).sort()).toEqual(["good-slug", "real-name"]);
  });

  it("skips honestly when neither frontmatter name nor slug is usable; hidden/underscore entries never load", () => {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const dir = join(root, ".acute", "skills");
    mkdirSync(join(dir, "Bad Name"), { recursive: true });
    writeFileSync(join(dir, "Bad Name", "SKILL.md"), "body", "utf8");
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    writeFileSync(join(dir, ".hidden", "SKILL.md"), "body", "utf8");
    mkdirSync(join(dir, "_notes"), { recursive: true });
    writeFileSync(join(dir, "_notes", "SKILL.md"), "body", "utf8");
    writeFileSync(join(dir, ".dotfile.md"), "body", "utf8");
    writeFileSync(join(dir, "readme.txt"), "not markdown", "utf8");

    expect(discoverProjectFileSkills(root)).toHaveLength(0);
  });

  it("the user-global source (~/.agents/skills stand-in) discovers the same way", () => {
    const globalRoot = globalRootWith({ "global-helper": FRONTMATTER_SKILL.replace("deploy-flow", "global-helper") });
    const skills = discoverGlobalFileSkills(globalRoot);
    expect(skills.map((s) => s.name)).toEqual(["global-helper"]);
    expect(skills[0]?.source).toBe("global-file");
    // A missing directory (the common case) is not an error.
    expect(discoverGlobalFileSkills(join(tempDir, "nope-does-not-exist"))).toEqual([]);
    expect(discoverProjectFileSkills(join(tempDir, "nope-does-not-exist"))).toEqual([]);
  });

  it("parseSkillFrontmatter: quoted values, unknown keys kept, unclosed → undefined", () => {
    const fm = parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'single\'\nallowed-tools: read_file\n---\nbody');
    expect(fm?.get("name")).toBe("quoted");
    expect(fm?.get("description")).toBe("single");
    expect(fm?.get("allowed-tools")).toBe("read_file");
    expect(parseSkillFrontmatter("---\nname: x\nno close fence")).toBeUndefined();
    expect(parseSkillFrontmatter("no frontmatter here")).toBeUndefined();
    expect(stripSkillFrontmatter("---\nname: x\n---\n\nthe body")).toBe("\nthe body");
    expect(stripSkillFrontmatter("just body")).toBe("just body");
  });

  it("description is capped at 500 chars; bodies at 60K; per-source cap 32 (honest skip beyond)", () => {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const dir = join(root, ".acute", "skills");
    mkdirSync(dir, { recursive: true });
    const longDesc = "D".repeat(700);
    mkdirSync(join(dir, "long-desc"), { recursive: true });
    writeFileSync(join(dir, "long-desc", "SKILL.md"), `---\nname: long-desc\ndescription: ${longDesc}\n---\nbody`, "utf8");
    expect(discoverProjectFileSkills(root)[0]?.description.length).toBe(FILE_SKILL_DESC_CAP);

    // 33 valid skills → exactly 32 discovered.
    for (let i = 0; i < FILE_SKILLS_PER_SOURCE_CAP + 1; i++) {
      const name = `bulk-${String(i).padStart(2, "0")}`;
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: bulk\n---\nbody`, "utf8");
    }
    const skills = discoverProjectFileSkills(root);
    expect(skills.length).toBe(FILE_SKILLS_PER_SOURCE_CAP);
    // Deterministic: the name-sorted first 32 (bulk-00 … bulk-31); bulk-32 skipped.
    expect(skills.some((s) => s.name === "bulk-32")).toBe(false);
    expect(skills.some((s) => s.name === "bulk-00")).toBe(true);

    // Body cap on load.
    const body = readFileSkillBody(join(dir, "long-desc", "SKILL.md"));
    expect(body.ok).toBe(true);
    const huge = "B".repeat(FILE_SKILL_BODY_CAP + 1000);
    writeFileSync(join(dir, "long-desc", "SKILL.md"), huge, "utf8");
    const capped = readFileSkillBody(join(dir, "long-desc", "SKILL.md"));
    expect(capped.ok).toBe(true);
    if (capped.ok) expect(capped.body.length).toBe(FILE_SKILL_BODY_CAP);
  });

  it("readFileSkillBody: frontmatter stripped, vanished file → honest failure", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const filePath = join(root, ".acute", "skills", "deploy-flow", "SKILL.md");
    const body = readFileSkillBody(filePath);
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.body).toContain("# Deploy flow");
      expect(body.body).not.toContain("name: deploy-flow");
    }
    unlinkSync(filePath);
    const gone = readFileSkillBody(filePath);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.note).toContain("no longer exists");
  });

  it("synthetic file ids are recognizable (the CRUD refusal guard)", () => {
    expect(isFileSkillId(fileSkillId("project-file", "deploy-flow", "proj-1"))).toBe(true);
    expect(isFileSkillId(fileSkillId("global-file", "helper", "global"))).toBe(true);
    expect(isFileSkillId("skill_builtin_computer_use")).toBe(false);
    expect(isFileSkillId("skill_deploy_flow_abc123")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the MERGE semantics + the effective index (prompt/read_skill view)
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D1: merge precedence + resolveEffectiveSkills", () => {
  it("DB row shadows a file skill of the same name — even a DISABLED DB row (hidden, not fall-through)", () => {
    const root = projectRootWith({ "my-flow": "---\nname: my-flow\ndescription: file version\n---\nfile body" });
    const all = resolveEffectiveSkills(db, { projectRoot: root });
    expect(all.find((s) => s.name === "my-flow")?.description).toBe("file version"); // no DB row yet → file visible

    const created = createSkill(db, { name: "my-flow", description: "db version", body: "db body" });
    expect(created.source).toBe("user");
    const after = resolveEffectiveSkills(db, { projectRoot: root });
    expect(after.find((s) => s.name === "my-flow")?.description).toBe("db version");

    updateSkill(db, created.id, { enabled: false });
    const disabled = resolveEffectiveSkills(db, { projectRoot: root });
    expect(disabled.find((s) => s.name === "my-flow")).toBeUndefined(); // hidden, NOT the file body
  });

  it("project file beats user-global file of the same name (nearest wins); both sources appear otherwise", () => {
    const root = projectRootWith({
      "shared-name": "---\nname: shared-name\ndescription: PROJECT version\n---\nproject body",
      "project-only": "---\nname: project-only\ndescription: project only\n---\nbody",
    });
    const globalRoot = globalRootWith({
      "shared-name": "---\nname: shared-name\ndescription: GLOBAL version\n---\nglobal body",
      "global-only": "---\nname: global-only\ndescription: global only\n---\nbody",
    });
    const skills = resolveEffectiveSkills(db, { projectRoot: root, globalRoot });
    expect(skills.find((s) => s.name === "shared-name")?.description).toBe("PROJECT version");
    expect(skills.find((s) => s.name === "project-only")?.source).toBe("project-file");
    expect(skills.find((s) => s.name === "global-only")?.source).toBe("global-file");
    // discoverFileSkills keeps the same nearest-wins pairing.
    const discovered = discoverFileSkills(root, globalRoot);
    expect(discovered.find((s) => s.name === "shared-name")?.description).toBe("PROJECT version");
  });

  it("the effective index orders DB skills first (sort_order), then file skills; entries carry provenance + ids", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const skills = resolveEffectiveSkills(db, { projectRoot: root, projectScope: "proj-42" });
    // The DB builtin rows ride the index (computer-use gated off by default —
    // see D4; the R71-e3 additions are part of the same set).
    const names = skills.map((s) => s.name);
    expect(names).toContain("code-review");
    expect(names).toContain("deploy-flow");
    const fileEntry = skills.find((s) => s.name === "deploy-flow");
    expect(fileEntry?.source).toBe("project-file");
    expect(fileEntry?.id).toBe(fileSkillId("project-file", "deploy-flow", "proj-42"));
    expect(fileEntry?.filePath).toBe(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1 — read_skill serves file bodies from disk at CALL time
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D1: read_skill + file skills (the plugin)", () => {
  const agentless = "agt_r70b_none";

  it("loads a file skill's body from disk (frontmatter stripped); the DB builtin body still comes from the row", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const readSkill = buildReadSkill(root, agentless);

    const file = readSkill.execute({ name: "deploy-flow" }, { root }) as { ok: boolean; output: string };
    expect(file.ok).toBe(true);
    expect(file.output).toContain("# Skill: deploy-flow");
    expect(file.output).toContain("# Deploy flow");
    expect(file.output).not.toContain("description: How this project ships");

    const dbSkill = readSkill.execute({ name: "code-review" }, { root }) as { ok: boolean; output: string };
    expect(dbSkill.ok).toBe(true);
    expect(dbSkill.output).toContain("# Skill: code-review");
    expect(dbSkill.output).toContain("Findings FIRST");
  });

  it("a vanished file skill de-lists honestly (re-discovery at call time); unknown names list the available set", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const readSkill = buildReadSkill(root, agentless);
    const filePath = join(root, ".acute", "skills", "deploy-flow", "SKILL.md");
    unlinkSync(filePath);

    // Discovery runs at CALL time, so a file deleted between turns simply
    // drops out of the index — the honest answer is "no such skill" and the
    // available list never advertises the dead one. (The mid-call race —
    // listed by discovery, gone at body-read — is covered by the direct
    // readFileSkillBody test above.)
    const gone = readSkill.execute({ name: "deploy-flow" }, { root }) as { ok: boolean; output: string };
    expect(gone.ok).toBe(false);
    expect(gone.output).toContain("no enabled skill named 'deploy-flow'");

    const unknown = readSkill.execute({ name: "no-such-skill" }, { root }) as { ok: boolean; output: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain("no enabled skill named 'no-such-skill'");
    expect(unknown.output).toContain("code-review"); // the available set is honest
    expect(unknown.output).not.toContain("deploy-flow");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the merged GET /skills listing + the read-only file-skill contract
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D1: server routes — merged listing + file-skill read-only", () => {
  beforeEach(() => {
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
  });

  async function authInject(options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse> {
    return (await app!.inject({
      ...options,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
  }

  it("GET /skills merges DB rows + project-file + global-file skills with provenance, filePath, and disk-read bodies", async () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    createProject(db, { name: "R70B Project", rootPath: root });
    createSkill(db, { name: "user-made", description: "a user skill", body: "user body" });

    const response = await authInject({ method: "GET", url: "/api/v1/skills" });
    expect(response.statusCode).toBe(200);
    const skills = (response.json() as { skills: Array<Record<string, unknown>> }).skills;

    const byName = new Map(skills.map((s) => [s.name as string, s]));
    // DB rows (all 18 builtins + the user skill) ride the listing as before.
    expect(byName.get("computer-use")?.source).toBe("builtin");
    expect(byName.get("code-review")?.source).toBe("builtin");
    expect(byName.get("user-made")?.source).toBe("user");
    // The project-file skill appears with provenance, the disk path, the
    // project's display name, and its body read from disk.
    const file = byName.get("deploy-flow");
    expect(file?.source).toBe("project-file");
    expect(file?.filePath).toBe(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"));
    expect(file?.projectName).toBe("R70B Project");
    expect(file?.body).toContain("# Deploy flow");
    expect(file?.enabled).toBe(true);
    expect(file?.id).toMatch(/^skill_file_p_/);
  });

  it("a DB skill shadows a same-name file skill in the listing too (the documented override path)", async () => {
    const root = projectRootWith({ "my-flow": "---\nname: my-flow\ndescription: file\n---\nbody" });
    createProject(db, { name: "Shadow", rootPath: root });
    createSkill(db, { name: "my-flow", description: "db override", body: "db body" });

    const response = await authInject({ method: "GET", url: "/api/v1/skills" });
    const skills = (response.json() as { skills: Array<Record<string, unknown>> }).skills;
    const mine = skills.filter((s) => s.name === "my-flow");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.source).toBe("user");
  });

  it("PATCH/DELETE on a file-skill id refuse 409 with the honest 'edit the SKILL.md' note", async () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    createProject(db, { name: "Refuse", rootPath: root });
    const id = fileSkillId("project-file", "deploy-flow", "proj-x");

    const patch = await authInject({
      method: "PATCH",
      url: `/api/v1/skills/${id}`,
      payload: { description: "hacked" },
    });
    expect(patch.statusCode).toBe(409);
    expect(((patch.json() as { error: { message: string } }).error.message)).toContain("file-defined skill");

    const del = await authInject({ method: "DELETE", url: `/api/v1/skills/${id}` });
    expect(del.statusCode).toBe(409);
    expect(((del.json() as { error: { message: string } }).error.message)).toContain("file-defined skill");
  });

  it("DB CRUD still works unchanged through the routes (create/patch/delete on a user skill)", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/skills",
      payload: { name: "round-trip", description: "d", body: "b" },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/skills/${id}`,
      payload: { description: "d2" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { description: string }).description).toBe("d2");

    const deleted = await authInject({ method: "DELETE", url: `/api/v1/skills/${id}` });
    expect(deleted.statusCode).toBe(204);
  });

  it("listAllSkillsMerged (storage-level): file bodies read best-effort, vanished files degrade to empty body", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    createProject(db, { name: "Merged", rootPath: root });
    const merged = listAllSkillsMerged(db);
    const file = merged.find((s) => s.name === "deploy-flow");
    expect(file?.body).toContain("# Deploy flow");
    unlinkSync(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"));
    const reread = listAllSkillsMerged(db);
    expect(reread.find((s) => s.name === "deploy-flow")).toBeUndefined(); // vanished → not listed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the seven R70-b built-ins (+ the four R71-e3 + the six R72-b additions)
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D2: the seven new built-in skills", () => {
  const NEW_BUILTINS: ReadonlyArray<[name: string, id: string]> = [
    ["code-review", "skill_builtin_code_review"],
    ["debugging", "skill_builtin_debugging"],
    ["testing", "skill_builtin_testing"],
    ["git-workflow", "skill_builtin_git_workflow"],
    ["web-research", "skill_builtin_web_research"],
    ["project-init", "skill_builtin_project_init"],
    ["browser-use", "skill_builtin_browser_use"],
    // R71-e3: the four new ones ride the same house-format contract.
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
  ];

  it("all EIGHTEEN builtins seed (computer-use + the seven R70-b + the four R71-e3 + the six R72-b additions), ordered by sort_order", () => {
    const skills = listSkills(db);
    const builtins = skills.filter((s) => s.source === "builtin");
    expect(builtins.map((s) => s.name)).toEqual([
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
    ]);
    expect(builtins.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(builtins.every((s) => s.enabled)).toBe(true);
  });

  it.each(NEW_BUILTINS)(
    "%s: body 800–2,200 chars, ≤ 60 lines, description ≤ 500, high-signal pins",
    (name, id) => {
      const skill = getSkill(db, id);
      expect(skill).toBeDefined();
      const body = skill?.body ?? "";
      expect(body.length).toBeGreaterThanOrEqual(800);
      expect(body.length).toBeLessThanOrEqual(2200);
      expect(body.trim().split("\n").length).toBeLessThanOrEqual(60);
      expect(body.startsWith(`# Skill: ${name}`)).toBe(true);
      expect((skill?.description ?? "").length).toBeGreaterThan(60);
      expect((skill?.description ?? "").length).toBeLessThanOrEqual(500);
    },
  );

  it("the bodies teach the intended disciplines (content pins)", () => {
    const bodies = new Map(listSkills(db).filter((s) => s.source === "builtin").map((s) => [s.name, s.body]));
    expect(bodies.get("code-review")).toContain("path:line");
    expect(bodies.get("code-review")).toContain("git_diff");
    expect(bodies.get("code-review")).toMatch(/no praise/i);
    expect(bodies.get("code-review")).toContain("verdict");
    expect(bodies.get("debugging")).toContain("READ THE ERROR FULLY");
    expect(bodies.get("debugging")).toContain("root cause");
    expect(bodies.get("debugging")).toContain("regression test");
    expect(bodies.get("testing")).toContain("failing test FIRST");
    expect(bodies.get("testing")).toMatch(/never weaken an assertion/i);
    expect(bodies.get("git-workflow")).toContain("git reset --hard");
    expect(bodies.get("git-workflow")).toContain("git add -A");
    expect(bodies.get("git-workflow")).toMatch(/commit ONLY when the user asks/i);
    expect(bodies.get("web-research")).toContain("web_search");
    expect(bodies.get("web-research")).toContain("primary sources");
    expect(bodies.get("project-init")).toContain("AGENTS.md");
    expect(bodies.get("project-init")).toContain("150 lines");
    expect(bodies.get("browser-use")).toContain("read_dom");
    expect(bodies.get("browser-use")).toContain("wait_for_verification");
    expect(bodies.get("browser-use")).toContain("submit:true");
  });

  it("INSERT OR IGNORE contract: user edits persist across reseeds; a deleted new builtin comes back on reopen", () => {
    // Edit persists.
    updateSkill(db, "skill_builtin_code_review", { body: "MY EDITED BODY" });
    seedBuiltinSkills(db);
    expect(getSkill(db, "skill_builtin_code_review")?.body).toBe("MY EDITED BODY");

    // A pre-R70 database (the row missing) gets it back on the next open.
    db.prepare("DELETE FROM skills WHERE id = ?").run("skill_builtin_browser_use");
    const path = join(tempDir, "reopen.db");
    const reopened = openDatabase(path);
    try {
      const revived = getSkill(reopened, "skill_builtin_browser_use");
      expect(revived?.name).toBe("browser-use");
      expect(revived?.body).toContain("read_dom");
    } finally {
      reopened.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — sticky skill bodies (the evaporation fix)
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D3: sticky read_skill / memory_recall results", () => {
  it("summarizeToolOutput: sticky tools keep up to 60K (no 4K head+tail mangling); others unchanged; back-compat without toolName", () => {
    expect(isStickyResultTool("read_skill")).toBe(true);
    expect(isStickyResultTool("memory_recall")).toBe(true);
    expect(isStickyResultTool("read_file")).toBe(false);

    const long = `# Skill: big\n\n${"X".repeat(5000)}`;
    const sticky = summarizeToolOutput(long, "read_skill");
    expect(sticky).toBe(long); // untouched — under the 60K sticky budget
    const mangled = summarizeToolOutput(long, "run_command");
    expect(mangled).toContain("…[truncated");
    expect(mangled.length).toBeLessThan(long.length);
    // No toolName (legacy call sites) = the old 4K behavior.
    expect(summarizeToolOutput(long)).toContain("…[truncated");
  });

  it("assembleHistory: a read_skill body loaded at call #2 stays FULL while older run_command results stub", () => {
    const sessionId = createSession(db, { agentId: "agt_r70b", mode: "single" }).id;
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_r70b",
      payload: { role: "user", content: "go" },
    });
    // 12 tool calls: #2 is read_skill with a >200-char body; the last 8
    // (4..11) are the RECENT set. Old non-sticky calls (0,1,3) stub;
    // read_skill (#2) must stay FULL.
    const skillBody = `# Skill: debugging\n\n${"FIX THE ROOT CAUSE. ".repeat(120)}END-OF-SKILL-BODY`;
    for (let i = 0; i < 12; i++) {
      appendSessionEvent(db, sessionId, {
        type: "tool.use",
        agentId: "agt_r70b",
        payload: {
          role: "tool",
          toolName: i === 2 ? "read_skill" : "run_command",
          argsSummary: i === 2 ? "name: debugging" : `cmd: step ${i}`,
          ok: true,
          outputSummary: i === 2 ? skillBody : `${"x".repeat(600)} output ${i}`,
        },
      });
    }
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId: "agt_r70b",
      payload: { role: "assistant", content: "done" },
    });

    const messages = assembleHistory(db, sessionId);
    const block = messages.find((m) => m.content.includes("<tool_results>"));
    expect(block).toBeDefined();
    const content = block!.content;

    // The read_skill line keeps its FULL body: the tail sentinel (~2,700
    // chars into the outputSummary, far beyond the 200-char stub point)
    // survives, and the total stub count stays at the 3 old non-sticky
    // calls (a stubbed read_skill would make it 4).
    expect(content).toContain("read_skill(name: debugging) → ok: # Skill: debugging");
    expect(content).toContain("END-OF-SKILL-BODY");
    // The older non-sticky results stub exactly (3 of them: 0, 1, 3).
    expect(content.match(/…\[older result truncated\]/g)?.length).toBe(3);
    // Recent run_command results stay full.
    expect(content).toContain("output 11");
  });

  it("memory_recall is sticky too (durable facts survive replay); the block cap still bounds pathological blocks", () => {
    const sessionId = createSession(db, { agentId: "agt_r70b", mode: "single" }).id;
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_r70b",
      payload: { role: "user", content: "go" },
    });
    const fact = `[fact] The build is pnpm-based. The build is pnpm-based. ${"durable. ".repeat(80)}`;
    for (let i = 0; i < 12; i++) {
      appendSessionEvent(db, sessionId, {
        type: "tool.use",
        agentId: "agt_r70b",
        payload: {
          role: "tool",
          toolName: i === 1 ? "memory_recall" : "run_command",
          argsSummary: i === 1 ? "query: build" : `cmd: step ${i}`,
          ok: true,
          outputSummary: i === 1 ? fact : `${"y".repeat(600)} out ${i}`,
        },
      });
    }
    const messages = assembleHistory(db, sessionId);
    const content = messages.find((m) => m.content.includes("<tool_results>"))!.content;
    const recallLine = content.split("\n").find((l) => l.startsWith("memory_recall(")) ?? "";
    expect(recallLine).not.toContain("[older result truncated]");
    expect(recallLine).toContain("durable.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — computer-use skill gating
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D4: the computer-use skill is gated by the master switch", () => {
  const agentless = "agt_r70b_none";

  it("switch OFF (the default): excluded from the effective index AND read_skill refuses it honestly", () => {
    const readSkill = buildReadSkill(tempDir, agentless);

    const skills = resolveEffectiveSkills(db, { projectRoot: tempDir });
    expect(skills.map((s) => s.name)).not.toContain("computer-use");
    expect(skills.map((s) => s.name)).toContain("code-review"); // the rest still listed

    const refused = readSkill.execute({ name: "computer-use" }, { root: tempDir }) as { ok: boolean; output: string };
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("computer use is disabled in settings");
    // The honest refusal does NOT advertise it in the available set either.
    const unknown = readSkill.execute({ name: "whatever" }, { root: tempDir }) as { ok: boolean; output: string };
    expect(unknown.output).not.toMatch(/computer-use/);
  });

  it("switch ON: listed and loadable exactly as before (the discipline rides the lit tools)", () => {
    setComputerUseSettings(db, { enabled: true });
    const readSkill = buildReadSkill(tempDir, agentless);

    const skills = resolveEffectiveSkills(db, { projectRoot: tempDir });
    expect(skills.map((s) => s.name)).toContain("computer-use");

    const loaded = readSkill.execute({ name: "computer-use" }, { root: tempDir }) as { ok: boolean; output: string };
    expect(loaded.ok).toBe(true);
    expect(loaded.output).toContain("Core loop");
  });

  it("the gate wins over the agent allowlist (dark tools are never advertised, even when listed by name)", () => {
    // Switch OFF + an agent that explicitly allowlists computer-use.
    const agent = createAgent(db, { name: "CU Fan", skills: ["computer-use", "code-review"] });
    const skills = resolveEffectiveSkills(db, { projectRoot: tempDir, agentSkills: agent.skills });
    expect(skills.map((s) => s.name)).toEqual(["code-review"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — agent.skills wired (the dead field comes alive)
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b D5: agent.skills filters the skill set", () => {
  it("a non-empty allowlist filters (builtin + file + user all filterable); empty/undefined = all (back-compat)", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    createSkill(db, { name: "user-made", description: "u", body: "u body" });

    const filtered = resolveEffectiveSkills(db, {
      projectRoot: root,
      agentSkills: ["code-review", "deploy-flow"],
    });
    expect(filtered.map((s) => s.name).sort()).toEqual(["code-review", "deploy-flow"]);

    const empty = resolveEffectiveSkills(db, { projectRoot: root, agentSkills: [] });
    expect(empty.length).toBeGreaterThan(filtered.length);
    expect(empty.map((s) => s.name)).toContain("user-made");

    const all = resolveEffectiveSkills(db, { projectRoot: root });
    expect(all.map((s) => s.name)).toEqual(empty.map((s) => s.name));
  });

  it("read_skill honors the agent's list (per-agent curation at the loader)", () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const agent = createAgent(db, { name: "Curated", skills: ["code-review"] });
    const readSkill = buildReadSkill(root, agent.id);

    const ok = readSkill.execute({ name: "code-review" }, { root }) as { ok: boolean; output: string };
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("Findings FIRST");

    const blocked = readSkill.execute({ name: "debugging" }, { root }) as { ok: boolean; output: string };
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toContain("no enabled skill named 'debugging'");
    expect(blocked.output).toContain("code-review");
    expect(blocked.output).not.toContain("debugging:"); // not advertised as loadable

    // An agent with skills: [] sees everything (back-compat).
    const open = createAgent(db, { name: "Open", skills: [] });
    const openRead = buildReadSkill(root, open.id);
    const any = openRead.execute({ name: "debugging" }, { root }) as { ok: boolean; output: string };
    expect(any.ok).toBe(true);
  });

  it("the AGENT CRUD round-trips the skills field (updateAgent patch path)", () => {
    const agent = createAgent(db, { name: "Patch Me", skills: ["testing"] });
    expect(agent.skills).toEqual(["testing"]);
    const patched = updateAgent(db, agent.id, { skills: ["testing", "debugging"] });
    expect(patched?.skills).toEqual(["testing", "debugging"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1/D4/D5 wiring — the END-TO-END prompt (prepareTurn → SKILLS section)
// ─────────────────────────────────────────────────────────────────────────────

describe("R70-b wiring: prepareTurn feeds the prompt SKILLS section from the shared resolver", () => {
  /** A fake chatStream that finishes cleanly (the system prompt is captured
   * by the wrapper below, before the generator starts). */
  function cleanStream(): AsyncGenerator<StreamChatEvent> {
    return (async function* () {
      yield { type: "text-delta", delta: "Task completed. It is done." };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    })();
  }

  interface StreamInputShape {
    system: string;
  }

  async function runTurnAndCaptureSystem(sessionId: string): Promise<string> {
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] })) as never,
      chatStream: (input: StreamInputShape) => {
        captured.system = input.system;
        return cleanStream();
      },
    };
    const outcome = await runStreamedAgentTurn(deps, sessionId, "do the thing", () => undefined);
    expect(outcome.ok).toBe(true);
    return captured.system;
  }

  it("agent skills=[\"code-review\"] → the SKILLS section lists ONLY that skill (D5) and never the gated computer-use (D4)", async () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const project = createProject(db, { name: "Wiring", rootPath: root });
    const agent = createAgent(db, {
      name: "Reviewer Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      skills: ["code-review"],
    });
    const sessionId = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;

    const system = await runTurnAndCaptureSystem(sessionId);
    expect(system).toContain("## SKILLS (load with read_skill)");
    expect(system).toContain("**code-review**");
    expect(system).not.toContain("**debugging**");
    expect(system).not.toContain("**deploy-flow**"); // the file skill is filtered out
    // D4: the computer-use builtin is NOT advertised while the switch is off.
    expect(system).not.toContain("**computer-use**");
  });

  it("agent skills=[] (the default) → every enabled skill rides the section (back-compat: the field stays inert-safe)", async () => {
    const root = projectRootWith({ "deploy-flow": FRONTMATTER_SKILL });
    const project = createProject(db, { name: "Wiring2", rootPath: root });
    const agent = createAgent(db, {
      name: "Default Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      skills: [],
    });
    const sessionId = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;

    const system = await runTurnAndCaptureSystem(sessionId);
    for (const name of ["code-review", "debugging", "testing", "git-workflow", "web-research", "project-init", "browser-use", "deploy-flow", "tdd", "api-design", "frontend-craft", "typescript-craft", "security-review", "refactoring"]) {
      expect(system).toContain(`**${name}**`);
    }
    expect(system).not.toContain("**computer-use**"); // D4 still gates (switch off)

    // Flipping the master switch ON adds the computer-use line (D4 on-state).
    setComputerUseSettings(db, { enabled: true });
    const sessionId2 = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;
    const system2 = await runTurnAndCaptureSystem(sessionId2);
    expect(system2).toContain("**computer-use**");
  });
});
