/**
 * ROUND-72 (R72-c) — REFERENCES DEPTH for file-based skills:
 *
 *   D1 — discovery lists <skill>/references/*.md as METADATA ONLY (name =
 *        the stem, fileName, bytes — sorted by fileName, ≤ 8, .md only with
 *        a case-sensitive extension, hidden/underscore skipped, > 64KB
 *        skipped + logged, unusable stems skipped). Flat-file skills and
 *        dir-form skills without a references/ dir get []. No content reads
 *        at discovery — the progressive-disclosure contract is unchanged.
 *   D2 — readSkillReference (the storage-level loader): sanitized name
 *        (traversal/separators rejected with the reason), the reference's
 *        own frontmatter stripped at READ time, 64KB cap with an honest
 *        marker, ENOENT honest.
 *   D3 — read_skill gains the optional `reference` parameter: a name-only
 *        call appends the references listing block with the exact call
 *        syntax (file skills only); a name+reference call loads THAT file
 *        through the SAME effective-skills resolution (computer-use gate
 *        and agent allowlist keep working — resolve first, then load).
 *        DB skills + reference → honest "no references".
 *   D4 — GET /skills carries the references metadata (additive; DB rows
 *        omit the field), plus the buildProjectTools end-to-end call.
 *
 * Fixture patterns mirror tests/r70-skills-system.test.ts (the file-skill
 * round this extends).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createSkill } from "../src/storage/skills";
import {
  discoverProjectFileSkills,
  FILE_SKILL_REFERENCES_CAP,
  FILE_SKILL_REFERENCE_SIZE_CAP,
  listAllSkillsMerged,
  readSkillReference,
  referenceNameRejection,
  resolveEffectiveSkills,
} from "../src/storage/skills-files";
import { setComputerUseSettings } from "../src/storage/computer-use";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { skillsPlugin } from "../src/tools/plugins/skills";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import type { ToolDefinition } from "../src/tools/registry";
import { ProviderKeyring } from "../src/providers/registry";
import { buildServer } from "../src/server";

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const TOKEN = "test-token-r72c";
const KEY = "sk-or-vtest-r72c";
const agentless = "agt_r72c_none";

let db: SqliteDatabase;
let tempDir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r72c-"));
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

/** A project root with .acute/skills/<name>/SKILL.md (+ references/<file>.md
 * files on demand) — the R72-c dir-form-with-references fixture. Reference
 * file KEYS are written in Object insertion order, which the test picks to
 * differ from the expected fileName sort. */
function projectRootWith(
  skills: Record<string, { skill: string; references?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tempDir, "proj-"));
  for (const [name, def] of Object.entries(skills)) {
    const dir = join(root, ".acute", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), def.skill, "utf8");
    if (def.references !== undefined) {
      for (const [fileName, content] of Object.entries(def.references)) {
        const refDir = join(dir, "references");
        mkdirSync(refDir, { recursive: true });
        writeFileSync(join(refDir, fileName), content, "utf8");
      }
    }
  }
  return root;
}

/** Capture the skills_files.* log lines while running fn: ACUTE_LOG_PATH is
 * pointed at a temp file (and the level pinned to info so warn lines land),
 * restored afterwards — the log module re-reads the env per call. */
function captureSkillFilesLog<T>(fn: () => T): { result: T; logged: string } {
  const logPath = join(tempDir, `r72c-${randomUUID()}.log`);
  const prevPath = process.env.ACUTE_LOG_PATH;
  const prevLevel = process.env.ACUTE_LOG_LEVEL;
  process.env.ACUTE_LOG_PATH = logPath;
  process.env.ACUTE_LOG_LEVEL = "info";
  try {
    const result = fn();
    let logged = "";
    try {
      logged = readFileSync(logPath, "utf8");
    } catch {
      // no log written (nothing skipped) — the empty string
    }
    return { result, logged };
  } finally {
    if (prevPath === undefined) delete process.env.ACUTE_LOG_PATH;
    else process.env.ACUTE_LOG_PATH = prevPath;
    if (prevLevel === undefined) delete process.env.ACUTE_LOG_LEVEL;
    else process.env.ACUTE_LOG_LEVEL = prevLevel;
  }
}

/** The read_skill tool built for the shared db + (optional) agent. */
function buildReadSkill(root: string, agentId: string) {
  const toolDeps = { db, sessionId: "sess_r72c", agentId } as ToolDeps;
  const tools = skillsPlugin.createTools({ root, toolDeps }) as ToolDefinition[];
  expect(tools.map((t) => t.name)).toEqual(["read_skill"]);
  return tools[0]!;
}

const REF_SKILL = `---
name: deploy-flow
description: How this project ships: tags, changelog, and the release checklist.
---
# Deploy flow

1. Run the tests.
2. Tag the release.`;

const REF_ALPHA = `---
name: alpha
description: The alpha deep-dive.
---
Alpha reference body. Windows service notes live here.`;
const REF_BETA = `Beta reference body — no frontmatter at all.`;
const REF_GAMMA = `Gamma reference body.`;

// ─────────────────────────────────────────────────────────────────────────────
// D1 — discovery: references/ as METADATA ONLY
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-c D1: references discovery (metadata only)", () => {
  it("lists references/*.md sorted by fileName with name=stem, fileName, bytes — and NOTHING else (no content)", () => {
    // Keys written in NON-sorted order (beta, gamma, alpha, Zulu) — the
    // listing must come out byte-order sorted ("Zulu.md" < "alpha.md").
    const root = projectRootWith({
      "deploy-flow": {
        skill: REF_SKILL,
        references: { "beta.md": REF_BETA, "gamma.md": REF_GAMMA, "alpha.md": REF_ALPHA, "Zulu.md": "Zulu body." },
      },
    });
    const skills = discoverProjectFileSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.references).toEqual([
      { name: "Zulu", fileName: "Zulu.md", bytes: Buffer.byteLength("Zulu body.", "utf8") },
      { name: "alpha", fileName: "alpha.md", bytes: Buffer.byteLength(REF_ALPHA, "utf8") },
      { name: "beta", fileName: "beta.md", bytes: Buffer.byteLength(REF_BETA, "utf8") },
      { name: "gamma", fileName: "gamma.md", bytes: Buffer.byteLength(REF_GAMMA, "utf8") },
    ]);
    // Metadata only — the exact deep-equal above pins the field set (no
    // body/content key can ride discovery).
  });

  it("frontmatter on a reference is counted in bytes at discovery and stripped at READ time (not discovery)", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA } },
    });
    const refs = discoverProjectFileSkills(root)[0]!.references;
    // Discovery metadata counts the WHOLE file (frontmatter included)…
    expect(refs[0]!.bytes).toBe(Buffer.byteLength(REF_ALPHA, "utf8"));
    // …while the READ strips it (below, exact content). The discovery
    // record itself never carries content to strip.
    const skillDir = join(root, ".acute", "skills", "deploy-flow");
    const loaded = readSkillReference(skillDir, "alpha");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.body).toBe("Alpha reference body. Windows service notes live here.");
      expect(loaded.body).not.toContain("name: alpha");
    }
  });

  it(">8 references → capped at the first 8 by fileName; the excess is skipped with an honest log", () => {
    const references: Record<string, string> = {};
    for (let i = 0; i < FILE_SKILL_REFERENCES_CAP + 3; i++) {
      references[`ref-${String(i).padStart(2, "0")}.md`] = `body ${i}`;
    }
    const root = projectRootWith({ "deploy-flow": { skill: REF_SKILL, references } });
    const { result: skills, logged } = captureSkillFilesLog(() => discoverProjectFileSkills(root));
    const refs = skills[0]!.references;
    expect(refs).toHaveLength(FILE_SKILL_REFERENCES_CAP);
    expect(refs.map((r) => r.name)).toEqual(
      Array.from({ length: FILE_SKILL_REFERENCES_CAP }, (_, i) => `ref-${String(i).padStart(2, "0")}`),
    );
    // ref-08 … ref-10 skipped; the cap event says so honestly.
    expect(logged).toContain("skills_files.reference_cap");
    expect(logged).toContain('"skipped":3');
  });

  it("non-.md files ignored (case-sensitive .MD too); hidden/underscore files and subdirectories skipped (one level only)", () => {
    const root = projectRootWith({
      "deploy-flow": {
        skill: REF_SKILL,
        references: {
          "good.md": "the good one",
          "notes.txt": "not markdown",
          "UPPER.MD": "uppercase extension — not .md",
          ".hidden.md": "hidden",
          "_draft.md": "underscore draft",
        },
      },
    });
    // A nested directory inside references/ is NOT traversed (one level).
    mkdirSync(join(root, ".acute", "skills", "deploy-flow", "references", "nested"), { recursive: true });
    writeFileSync(join(root, ".acute", "skills", "deploy-flow", "references", "nested", "deep.md"), "too deep", "utf8");

    const refs = discoverProjectFileSkills(root)[0]!.references;
    expect(refs.map((r) => r.name)).toEqual(["good"]);
  });

  it("a reference larger than 64KB is skipped at discovery (honest log); a file exactly AT the cap is kept", () => {
    const root = projectRootWith({
      "deploy-flow": {
        skill: REF_SKILL,
        references: {
          "big.md": "B".repeat(FILE_SKILL_REFERENCE_SIZE_CAP + 1),
          "at-cap.md": "A".repeat(FILE_SKILL_REFERENCE_SIZE_CAP),
        },
      },
    });
    const { result: skills, logged } = captureSkillFilesLog(() => discoverProjectFileSkills(root));
    const refs = skills[0]!.references;
    expect(refs.map((r) => r.name)).toEqual(["at-cap"]);
    expect(logged).toContain("skills_files.reference_skipped");
    expect(logged).toContain("too large");
  });

  it("an unusable reference stem (spaces, …) is skipped — everything listed is loadable by the sanitized loader", () => {
    const root = projectRootWith({
      "deploy-flow": {
        skill: REF_SKILL,
        references: { "my ref.md": "spaces in the stem", "ok.md": "fine" },
      },
    });
    expect(discoverProjectFileSkills(root)[0]!.references.map((r) => r.name)).toEqual(["ok"]);
  });

  it("flat-file skills always have references: []; a dir-form skill without references/ does too", () => {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const dir = join(root, ".acute", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flat.md"), "---\nname: flat\ndescription: flat skill\n---\nflat body", "utf8");
    mkdirSync(join(dir, "noref"), { recursive: true });
    writeFileSync(join(dir, "noref", "SKILL.md"), "---\nname: noref\ndescription: no refs\n---\nbody", "utf8");

    const skills = discoverProjectFileSkills(root);
    expect(skills.find((s) => s.name === "flat")!.references).toEqual([]);
    expect(skills.find((s) => s.name === "noref")!.references).toEqual([]);
  });

  it("references ride the effective index; a DB row shadowing the name removes them (precedence intact)", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA, "beta.md": REF_BETA } },
    });
    const effective = resolveEffectiveSkills(db, { projectRoot: root, projectScope: "proj-42" });
    const entry = effective.find((s) => s.name === "deploy-flow");
    expect(entry?.filePath).toBe(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"));
    expect(entry?.references?.map((r) => r.name)).toEqual(["alpha", "beta"]);
    // DB entries (the builtins) never carry the field.
    expect(effective.find((s) => s.name === "code-review")?.references).toBeUndefined();

    // The documented override path: a DB row shadows the file skill — the
    // references go with it (a disabled row hides, never falls through).
    createSkill(db, { name: "deploy-flow", description: "db override", body: "db body" });
    const after = resolveEffectiveSkills(db, { projectRoot: root });
    expect(after.find((s) => s.name === "deploy-flow")?.references).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — readSkillReference (the storage-level loader)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-c D2: readSkillReference (storage-level)", () => {
  it("loads by name from the skill DIRECTORY: frontmatter stripped, content exact", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA, "beta.md": REF_BETA } },
    });
    const loaded = readSkillReference(join(root, ".acute", "skills", "deploy-flow"), "beta");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.body).toBe("Beta reference body — no frontmatter at all.");
  });

  it("accepts the SKILL.md PATH too (a .md suffix → the parent dir is the skill dir)", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA } },
    });
    const loaded = readSkillReference(join(root, ".acute", "skills", "deploy-flow", "SKILL.md"), "alpha");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.body).toBe("Alpha reference body. Windows service notes live here.");
  });

  it("ENOENT is honest: the reference vanished after the session listed it", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA } },
    });
    unlinkSync(join(root, ".acute", "skills", "deploy-flow", "references", "alpha.md"));
    const gone = readSkillReference(join(root, ".acute", "skills", "deploy-flow"), "alpha");
    expect(gone.ok).toBe(false);
    if (!gone.ok) {
      expect(gone.note).toContain("reference file no longer exists");
      expect(gone.note).toContain(join("references", "alpha.md"));
    }
  });

  it("traversal and unsafe names are rejected with the reason — never resolved", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA } },
    });
    const skillDir = join(root, ".acute", "skills", "deploy-flow");
    // ".." itself matches the token regex but resolves to a file literally
    // named "...md" INSIDE references/ (never a traversal) — the genuinely
    // unsafe shapes are separators, drive colons, and the empty string.
    for (const bad of ["../../secret", "a/b", "a\\b", "con:x", ""]) {
      const rejected = readSkillReference(skillDir, bad);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.note).toBe(referenceNameRejection(bad));
    }
    // …and the guard text names the rule.
    expect(referenceNameRejection("../../secret")).toContain("no path separators, no traversal");
  });

  it("a file that grew past the 64KB cap is bounded at READ time with an honest marker", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "huge.md": "H".repeat(70_000) } },
    });
    const loaded = readSkillReference(join(root, ".acute", "skills", "deploy-flow"), "huge");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // (Discovery would have SKIPPED this file — the direct loader path is
      // the growth-race guard; the marker is the honesty contract.)
      expect(loaded.body.startsWith("H".repeat(100))).toBe(true);
      expect(loaded.body).toContain(`…[reference truncated: ${FILE_SKILL_REFERENCE_SIZE_CAP} of 70000 chars shown`);
      expect(loaded.body).toContain("the file on disk is larger than the 64KB reference cap");
      expect(loaded.body.length).toBeLessThan(FILE_SKILL_REFERENCE_SIZE_CAP + 200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — read_skill: the listing block + reference loads (the plugin)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-c D3: read_skill — listing block + reference loads", () => {
  function refRoot(): string {
    return projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA, "beta.md": REF_BETA } },
    });
  }

  it("a name-only call appends the references listing block with the EXACT call syntax (file skills only)", () => {
    const root = refRoot();
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "deploy-flow" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Skill: deploy-flow");
    expect(result.output).toContain("# Deploy flow");
    expect(result.output.endsWith(
      '\n\nreferences available: alpha, beta — load with read_skill { name: "deploy-flow", reference: "alpha" }',
    )).toBe(true);
  });

  it("no references → NO listing block; a DB skill's output is unchanged", () => {
    const root = projectRootWith({ plain: { skill: "---\nname: plain\ndescription: no refs\n---\nbody" } });
    const readSkill = buildReadSkill(root, agentless);
    const file = readSkill.execute({ name: "plain" }, { root }) as { ok: boolean; output: string };
    expect(file.ok).toBe(true);
    expect(file.output).not.toContain("references available");

    const dbSkill = readSkill.execute({ name: "code-review" }, { root }) as { ok: boolean; output: string };
    expect(dbSkill.ok).toBe(true);
    expect(dbSkill.output).not.toContain("references available");
    expect(dbSkill.output).toContain("# Skill: code-review");
  });

  it("{name, reference} loads THAT file: header + exact content, frontmatter stripped", () => {
    const root = refRoot();
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "deploy-flow", reference: "alpha" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      "# Skill: deploy-flow — reference: alpha\n\nAlpha reference body. Windows service notes live here.",
    );
  });

  it("an unknown reference → honest listing of the available ones with the call syntax", () => {
    const root = refRoot();
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "deploy-flow", reference: "nope" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain("read_skill: skill 'deploy-flow' has no reference named 'nope'");
    expect(result.output).toContain("Available references: alpha, beta");
    expect(result.output).toContain('load with read_skill { name: "deploy-flow", reference: "alpha" }');
  });

  it("a traversal attempt (reference: '../../secret') is rejected with the reason", () => {
    const root = refRoot();
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "deploy-flow", reference: "../../secret" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`read_skill: ${referenceNameRejection("../../secret")}`);
    expect(result.output).toContain("no path separators, no traversal");
  });

  it("a DB skill + reference → honest 'no references' (database skills carry none)", () => {
    const readSkill = buildReadSkill(tempDir, agentless);
    const result = readSkill.execute({ name: "code-review", reference: "anything" }, { root: tempDir }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain("read_skill: skill 'code-review' has no references");
    expect(result.output).toContain("database skills carry no reference files");
  });

  it("a file skill with NO references + reference → honest 'no references to load'", () => {
    const root = projectRootWith({ plain: { skill: "---\nname: plain\ndescription: no refs\n---\nbody" } });
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "plain", reference: "x" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain("read_skill: skill 'plain' has no references to load");
    expect(result.output).toContain("references/");
  });

  it("computer-use gated off + reference → the SAME gate message (resolve first, then load)", () => {
    const readSkill = buildReadSkill(tempDir, agentless);
    const result = readSkill.execute({ name: "computer-use", reference: "core" }, { root: tempDir }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain("computer use is disabled in settings");
    expect(result.output).toContain("there is nothing to load");
  });

  it("the agent allowlist gates reference loads exactly like body loads (one shared resolver)", () => {
    const root = refRoot();
    const allowed = createAgent(db, { name: "Allowed", skills: ["deploy-flow"] });
    const blocked = createAgent(db, { name: "Blocked", skills: ["code-review"] });

    const okRead = buildReadSkill(root, allowed.id);
    const loaded = okRead.execute({ name: "deploy-flow", reference: "beta" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(loaded.ok).toBe(true);
    expect(loaded.output).toContain("# Skill: deploy-flow — reference: beta");

    const blockedRead = buildReadSkill(root, blocked.id);
    const refused = blockedRead.execute({ name: "deploy-flow", reference: "beta" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("no enabled skill named 'deploy-flow'");
  });

  it("a reference in the 60K..64KB window is trimmed to the output budget WITH an honest marker (no silent cut)", () => {
    // 61,000 chars — under the 64KB discovery cap, over read_skill's 60K
    // output budget (the sticky budget chat.ts grants read_skill results).
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "long.md": "C".repeat(61_000) } },
    });
    const readSkill = buildReadSkill(root, agentless);
    const result = readSkill.execute({ name: "deploy-flow", reference: "long" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(60_000);
    expect(result.output).toContain("…[reference truncated:");
    expect(result.output).toContain("of 61000 chars shown");
    expect(result.output.endsWith("]")).toBe(true);
  });

  it("the computer-use switch ON: the skill loads (body path) with references unaffected — gate parity", () => {
    setComputerUseSettings(db, { enabled: true });
    const readSkill = buildReadSkill(tempDir, agentless);
    const result = readSkill.execute({ name: "computer-use" }, { root: tempDir }) as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Core loop");
    expect(result.output).not.toContain("references available"); // a DB skill, no listing block
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — the merged GET /skills listing carries the references metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-c D4: GET /skills carries references (additive)", () => {
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

  it("file-skill entries carry references (name/fileName/bytes — metadata only); DB rows omit the field", async () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA, "beta.md": REF_BETA } },
    });
    createProject(db, { name: "R72C Project", rootPath: root });
    createSkill(db, { name: "user-made", description: "a user skill", body: "user body" });

    const response = await authInject({ method: "GET", url: "/api/v1/skills" });
    expect(response.statusCode).toBe(200);
    const skills = (response.json() as { skills: Array<Record<string, unknown>> }).skills;
    const byName = new Map(skills.map((s) => [s.name as string, s]));

    const file = byName.get("deploy-flow");
    expect(file?.source).toBe("project-file");
    expect(file?.references).toEqual([
      { name: "alpha", fileName: "alpha.md", bytes: Buffer.byteLength(REF_ALPHA, "utf8") },
      { name: "beta", fileName: "beta.md", bytes: Buffer.byteLength(REF_BETA, "utf8") },
    ]);
    // Metadata only — no reference CONTENT rides the listing.
    expect(JSON.stringify(file)).not.toContain("Windows service notes");

    // DB rows (user + builtin) omit the field entirely — additive.
    expect(byName.get("user-made")?.references).toBeUndefined();
    expect(byName.get("code-review")?.references).toBeUndefined();
  });

  it("listAllSkillsMerged (storage-level): the project-file entry carries references + projectName", () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA } },
    });
    createProject(db, { name: "Merged", rootPath: root });
    const merged = listAllSkillsMerged(db);
    const file = merged.find((s) => s.name === "deploy-flow");
    expect(file?.projectName).toBe("Merged");
    expect(file?.references?.map((r) => r.name)).toEqual(["alpha"]);
    expect(merged.find((s) => s.name === "code-review")?.references).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END — read_skill { name, reference } through the full tool registry
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-c end-to-end: buildProjectTools", () => {
  it("read_skill in the FULL registry loads a reference from a fixture skill dir", async () => {
    const root = projectRootWith({
      "deploy-flow": { skill: REF_SKILL, references: { "alpha.md": REF_ALPHA, "beta.md": REF_BETA } },
    });
    const deps = { db, sessionId: "sess_r72c_e2e", agentId: agentless } as ToolDeps;
    const tools = await buildProjectTools(root, undefined, deps);
    const readSkill = (tools as unknown as Record<string, {
      execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
    }>)["read_skill"];
    expect(readSkill).toBeDefined();

    // Body first (the listing block teaches the call), then the reference.
    const body = await readSkill.execute({ name: "deploy-flow" });
    expect(body.ok).toBe(true);
    expect(body.output).toContain(
      'references available: alpha, beta — load with read_skill { name: "deploy-flow", reference: "alpha" }',
    );

    const loaded = await readSkill.execute({ name: "deploy-flow", reference: "beta" });
    expect(loaded.ok).toBe(true);
    expect(loaded.output).toBe("# Skill: deploy-flow — reference: beta\n\nBeta reference body — no frontmatter at all.");
  });
});
