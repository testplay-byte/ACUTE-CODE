/**
 * ROUND-73 (R73-b) — the TASK MODES BACKEND round (the posture tier's
 * integration wave; modes.ts + system-reminders.ts are wave-1, landed):
 *
 *   D1 — REGISTRY + COMPOSITION: the prompt registry's two new sections
 *        ("task-modes" — the available-mode index + the per-turn mode
 *        signal line; "active-mode" — the ACTIVE mode's deep posture
 *        module) sit DIRECTLY after "skills"; both are strictly ctx-gated
 *        so a caller without the fields composes BYTE-IDENTICALLY (the
 *        golden fixture's proof — its md5 never moves); the sections ride
 *        the id-stamping + the .acute/prompts/<id>.md override machinery
 *        like every other section.
 *   D2 — computeModeHints: the R72-a scorer, reused VERBATIM over mode
 *        descriptions (phrase hits qualify; token threshold; top-2;
 *        score desc + id ASC ties; empty message/modes → []; contraction
 *        flattening; the 8K cap). computeTaskHints keeps its exact shape
 *        (skillName) — the r72 suite is the hard gate and stays green
 *        UNMODIFIED.
 *   D3 — STORAGE + MIGRATION 0027: sessions.active_mode (NULL default =
 *        pre-R73 behavior), the storage-level setter, the fork carries the
 *        posture, and the allowlist append (template/default rows with
 *        read_skill gain switch_mode; [] rows, read_skill-less rows, and
 *        user curation untouched; idempotent).
 *   D4 — ROUTES: PATCH /sessions/:id { activeMode } (set / clear / null /
 *        unknown → 400 with the available ids / absent = untouched) and
 *        the project-scoped GET /projects/:id/modes (METADATA ONLY — no
 *        body field ever; 404 on an unknown project; customs appear).
 *   D5 — the switch_mode TOOL: absent → the index (with the active
 *        marker); a valid id → "# Task mode ACTIVE:" + the full body + the
 *        fenced task-mode reminder + the session row updated; the clear
 *        sentinels ("none"/"off"/null) deactivate honestly (idempotent);
 *        an unknown id → ok:false + available ids + the .acute/agents
 *        hint; the null-db guard; custom ids resolve through the project
 *        root.
 *   D6 — RUNTIME INTEGRATION (the r72-a D3 pattern — system captured from
 *        the chat adapters on BOTH turn paths): the TASK MODES index +
 *        the mode signal line thread into every project turn; the ACTIVE
 *        mode's body rides its section; a VANISHED custom mode is cleared
 *        with the honest one-turn note; a file-mode's `tools` frontmatter
 *        NARROWS the toolset (NO_TOOLS on an empty intersection).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import Database from "better-sqlite3";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import {
  createSession,
  forkSession,
  getSession,
  updateSessionActiveMode,
} from "../src/storage/sessions";
import { runSingleAgentTurn, runStreamedAgentTurn, narrowAllowListByTaskMode } from "../src/agents/runtime";
import { computeModeHints, computeTaskHints } from "../src/agents/task-hints";
import { buildProjectSystemPrompt, buildTaggedPromptLines } from "../src/agents/prompts";
import { PROMPT_REGISTRY, PROMPT_SECTION_IDS } from "../src/agents/prompt-registry";
import { BUILTIN_MODES, resolveEffectiveModes, findMode } from "../src/agents/modes";
import { renderReminder } from "../src/agents/system-reminders";
import { modesPlugin } from "../src/tools/plugins/modes";
import type { ToolDeps } from "../src/tools/index";
import { NO_TOOLS } from "../src/tools/index";
import { TOOL_NAMES } from "../src/storage/agents";
import { buildServer } from "../src/server";
import { ProviderKeyring } from "../src/providers/registry";
import type { StreamChatEvent } from "../src/agents/chat";

/* ── fixtures ───────────────────────────────────────────────────────────────── */

const TOKEN = "test-token-r73b";
const KEY = "sk-or-vtest-r73b";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r73b-"));
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

/** A hermetic base ctx — a root that never exists (no overrides). */
const BASE_CTX = {
  projectName: "R73bProject",
  rootPath: "/tmp/acute-r73b-never-exists",
  toolNames: ["read_file", "switch_mode"],
};

const TWO_MODES = [
  {
    id: "plan",
    name: "Plan",
    description: "Use when the user says 'plan this', 'write a spec' — the deliverable is a decision-ready specification, not code.",
  },
  {
    id: "debug",
    name: "Debug",
    description: "Use when the user says 'fix this bug', 'why does this fail' — the cause is unknown; reproduce before theorizing.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// D1 — registry + composition
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D1: the registry + the two composed sections", () => {
  it("the registry pins 24 sections (21 pre-R73 + task-modes + active-mode + ROUND-79 background-tasks), the R73 pair sitting DIRECTLY after skills", () => {
    // ROUND-79 (R79-a): 23 → 24 — the background-tasks section (the per-turn
    // uncollected-delegation reminder) joined the registry directly after
    // active-mode. The count pin is versioned by design: every section round
    // moves it (R73 moved it 21 → 23 the same way).
    expect(PROMPT_SECTION_IDS.length).toBe(24);
    expect(PROMPT_REGISTRY.length).toBe(24);
    expect(PROMPT_SECTION_IDS.indexOf("task-modes")).toBe(PROMPT_SECTION_IDS.indexOf("skills") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("active-mode")).toBe(PROMPT_SECTION_IDS.indexOf("task-modes") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("active-mode")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("computer-use"));
    // ROUND-79 (R79-a): background-tasks sits DIRECTLY after active-mode
    // (the delegation reminder rides the posture pair, before computer-use).
    expect(PROMPT_SECTION_IDS.indexOf("background-tasks")).toBe(PROMPT_SECTION_IDS.indexOf("active-mode") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("background-tasks")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("computer-use"));
    // The pair is DYNAMIC + identity-bucket, like the design entry says.
    const taskModes = PROMPT_REGISTRY.find((s) => s.id === "task-modes");
    const activeMode = PROMPT_REGISTRY.find((s) => s.id === "active-mode");
    expect(taskModes?.dynamic).toBe(true);
    expect(taskModes?.bucket).toBe("identity");
    expect(activeMode?.dynamic).toBe(true);
    expect(activeMode?.bucket).toBe("identity");
  });

  it("STRICT GATING: a ctx without the R73 fields composes byte-identically (taskModes/modeHints/activeTaskMode/clearedModeNote all optional)", () => {
    const without = buildProjectSystemPrompt(BASE_CTX);
    // Absent vs empty vs explicitly undefined — all the same bytes.
    expect(buildProjectSystemPrompt({ ...BASE_CTX, taskModes: [] })).toBe(without);
    expect(buildProjectSystemPrompt({ ...BASE_CTX, taskModes: undefined })).toBe(without);
    expect(
      buildProjectSystemPrompt({
        ...BASE_CTX,
        modeHints: [],
        activeTaskMode: undefined,
        clearedModeNote: undefined,
      }),
    ).toBe(without);
    // And the composition's TAIL (where the new sections would sit, right
    // after the SKILLS block's position in the order) contains neither
    // heading — the golden fixture's local proof.
    expect(without).not.toContain("## TASK MODES");
    expect(without).not.toContain("## ACTIVE TASK MODE");
  });

  it("a ctx with 2 modes composes the index: the heading, the division line, one line per mode", () => {
    const prompt = buildProjectSystemPrompt({ ...BASE_CTX, taskModes: TWO_MODES });
    expect(prompt).toContain("## TASK MODES (posture modules — activate with switch_mode)");
    expect(prompt).toContain(
      "Skills carry methodology you read with read_skill; a task mode changes your operating POSTURE for a class of work — while active, its guide below governs how you approach the task. Modes are selected on the basis of the task; nothing auto-activates.",
    );
    expect(prompt).toContain("- plan: Plan — Use when the user says 'plan this', 'write a spec' — the deliverable is a decision-ready specification, not code.");
    expect(prompt).toContain("- debug: Debug — Use when the user says 'fix this bug', 'why does this fail' — the cause is unknown; reproduce before theorizing.");
    // The section sits AFTER the skills-tier position and rides the
    // id-stamping: its lines are stamped "task-modes" contiguously.
    const ids: string[] = [];
    for (const entry of buildTaggedPromptLines({ ...BASE_CTX, taskModes: TWO_MODES })) {
      if (ids[ids.length - 1] !== entry.sectionId) ids.push(entry.sectionId as string);
    }
    expect(ids).toContain("task-modes");
    expect(ids.indexOf("task-modes")).toBeGreaterThan(-1);
  });

  it("one mode hint → the exact advisory line naming the mode id with the concrete switch_mode call", () => {
    const prompt = buildProjectSystemPrompt({
      ...BASE_CTX,
      taskModes: TWO_MODES,
      modeHints: [{ modeId: "debug", score: 12 }],
    });
    expect(prompt).toContain(
      'Task signal: this request looks like the **debug** posture — consider switch_mode { mode: "debug" } FIRST.',
    );
  });

  it("two mode hints → the exact '(and possibly …)' advisory line", () => {
    const prompt = buildProjectSystemPrompt({
      ...BASE_CTX,
      taskModes: TWO_MODES,
      modeHints: [
        { modeId: "debug", score: 12 },
        { modeId: "plan", score: 9 },
      ],
    });
    expect(prompt).toContain(
      "Task signal: this request looks like the **debug** posture (and possibly **plan**) — consider switch_mode FIRST.",
    );
  });

  it("mode hints render ONLY inside the TASK MODES section (hints without an index compose nothing)", () => {
    const withHintsNoModes = buildProjectSystemPrompt({
      ...BASE_CTX,
      taskModes: [],
      modeHints: [{ modeId: "debug", score: 12 }],
    });
    const neither = buildProjectSystemPrompt(BASE_CTX);
    expect(withHintsNoModes).toBe(neither);
    expect(withHintsNoModes).not.toContain("Task signal:");
  });

  it("activeTaskMode composes the deep module: heading, the activation note, the full body VERBATIM", () => {
    const body = "# Mode: plan — SPEC-FIRST POSTURE\n\nWhile this mode is active, the deliverable is a DECISION-READY SPECIFICATION, not code.\n\n## Iron law\nNO EDITS.";
    const prompt = buildProjectSystemPrompt({
      ...BASE_CTX,
      taskModes: TWO_MODES,
      activeTaskMode: { id: "plan", name: "Plan", body },
    });
    expect(prompt).toContain("## ACTIVE TASK MODE — Plan (plan)");
    expect(prompt).toContain(
      'This posture is ACTIVE for this session (set via switch_mode or the mode picker). Follow it for the rest of the task. Clear with switch_mode { mode: "none" }.',
    );
    // The body rides verbatim, every line of it.
    for (const line of body.split("\n")) expect(prompt).toContain(line);
    // Section order: the active module sits directly after the index.
    expect(prompt.indexOf("## TASK MODES")).toBeGreaterThan(-1);
    expect(prompt.indexOf("## ACTIVE TASK MODE")).toBeGreaterThan(prompt.indexOf("## TASK MODES"));
  });

  it("clearedModeNote renders as the bracketed honest line INSIDE the task-modes section (after the list)", () => {
    const note =
      "task mode 'custom-mode' from a previous turn no longer exists (its .acute/agents file was removed) — active mode cleared";
    const prompt = buildProjectSystemPrompt({
      ...BASE_CTX,
      taskModes: TWO_MODES,
      clearedModeNote: note,
    });
    expect(prompt).toContain(`[${note}]`);
    const idxList = prompt.indexOf("- debug: Debug —");
    const idxNote = prompt.indexOf(`[${note}]`);
    expect(idxList).toBeGreaterThan(-1);
    expect(idxNote).toBeGreaterThan(idxList);
    // Without a task-modes section the note renders nowhere.
    expect(buildProjectSystemPrompt({ ...BASE_CTX, clearedModeNote: note })).toBe(
      buildProjectSystemPrompt(BASE_CTX),
    );
  });

  it(".acute/prompts/task-modes.md replaces the section wholesale; .acute/prompts/active-mode.md does too (the override machinery works for the pair)", () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r73b-ovr-"));
    try {
      const dir = join(root, ".acute", "prompts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "task-modes.md"), "## TASK MODES (project override)\nR73B-MARKER-TASK-MODES\nOur postures.");
      writeFileSync(join(dir, "active-mode.md"), "## ACTIVE TASK MODE (project override)\nR73B-MARKER-ACTIVE-MODE");
      const prompt = buildProjectSystemPrompt({
        ...BASE_CTX,
        rootPath: root,
        taskModes: TWO_MODES,
        activeTaskMode: { id: "plan", name: "Plan", body: "NO EDITS." },
      });
      expect(prompt).toContain("R73B-MARKER-TASK-MODES");
      expect(prompt).toContain("R73B-MARKER-ACTIVE-MODE");
      // The built-in bodies are replaced wholesale (dynamic parts included).
      expect(prompt).not.toContain("## TASK MODES (posture modules — activate with switch_mode)");
      expect(prompt).not.toContain("## ACTIVE TASK MODE — Plan (plan)");
      expect(prompt).not.toContain("- plan: Plan — Use when the user says 'plan this'");
      expect(prompt).not.toContain("NO EDITS.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — computeModeHints (the shared scorer)
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D2: computeModeHints (the R72-a scorer over mode descriptions)", () => {
  it("a quoted phrase hit is the strong signal: word-count × 5 (plus its own token hits)", () => {
    const modes = [
      { id: "debug", description: "Use when the user says 'fix this bug' and the cause is unknown." },
    ];
    // 'fix this bug' = 3 words × 5 = 15 + tokens 'fix'/'bug' (this is a
    // stopword) = 17.
    expect(computeModeHints("please fix this bug now", modes)).toEqual([{ modeId: "debug", score: 17 }]);
  });

  it("token hits accumulate without phrases; the threshold (≥2) keeps a lone token out", () => {
    const modes = [{ id: "release", description: "The release flow: tags, changelog, checklist." }];
    expect(computeModeHints("update the changelog and checklist", modes)).toEqual([
      { modeId: "release", score: 2 },
    ]);
    const solo = [{ id: "solo", description: "alpha beta gamma" }];
    expect(computeModeHints("alpha", solo)).toEqual([]);
  });

  it("top-2 cap with score-desc ordering", () => {
    const modes = [
      { id: "mode-a", description: "Use when 'fix the login page'." },
      { id: "mode-b", description: "Use when 'ship it'." },
      { id: "mode-c", description: "Use when 'deploy'." },
    ];
    const hints = computeModeHints("fix the login page, ship it, deploy", modes);
    expect(hints.map((h) => h.modeId)).toEqual(["mode-a", "mode-b"]);
    expect(hints.map((h) => h.score)).toEqual([23, 11]);
  });

  it("equal scores tie-break by ID ASCENDING (skills use name asc; modes use id asc — switch_mode addresses ids)", () => {
    const modes = [
      { id: "zeta", description: "alpha phrase" },
      { id: "beta", description: "alpha phrase" },
    ];
    expect(computeModeHints("alpha phrase present", modes).map((h) => h.modeId)).toEqual(["beta", "zeta"]);
  });

  it("empty/whitespace message → []; no modes → []", () => {
    const modes = [{ id: "x", description: "alpha beta" }];
    expect(computeModeHints("", modes)).toEqual([]);
    expect(computeModeHints("   \n\t ", modes)).toEqual([]);
    expect(computeModeHints("alpha beta", [])).toEqual([]);
  });

  it("contractions flatten on BOTH sides (the shared core, unchanged)", () => {
    const modes = [{ id: "zero", description: "Use when the user says 'don't hallucinate' about APIs." }];
    expect(computeModeHints("don't hallucinate the fetch call", modes)).toEqual([{ modeId: "zero", score: 12 }]);
    expect(computeModeHints("the don says hi", modes)).toEqual([]);
  });

  it("the message is capped at 8K chars — a match beyond the cap is not seen", () => {
    const modes = [{ id: "parade", description: "Use when the user says 'elephant'." }];
    expect(computeModeHints(`${"pad ".repeat(2000)}elephant`, modes)).toEqual([]);
    expect(computeModeHints(`${"pad ".repeat(1990)}elephant`, modes)).toEqual([{ modeId: "parade", score: 6 }]);
  });

  it("cross-validation against the REAL builtin descriptions: 'fix this bug' surfaces debug first; an unrelated message stays silent", () => {
    const hints = computeModeHints("my test keeps failing, fix this bug", BUILTIN_MODES);
    expect(hints[0]?.modeId).toBe("debug");
    expect(hints.length).toBeLessThanOrEqual(2);
    // The plan posture does NOT surface for a defect message.
    expect(hints.map((h) => h.modeId)).not.toContain("build");
    expect(computeModeHints("what is the capital of France", BUILTIN_MODES)).toEqual([]);
  });

  it("computeTaskHints keeps its EXACT shape and tie-break (the r72 contract — that suite is the hard gate)", () => {
    // Same shared core, skillName surface, name-asc ties: the smoke proof
    // that the refactor changed nothing (r72-task-hints 27/27 is the gate).
    const skills = [
      { name: "zeta", description: "alpha phrase" },
      { name: "beta", description: "alpha phrase" },
    ];
    expect(computeTaskHints("alpha phrase present", skills)).toEqual([
      { skillName: "beta", score: 2 },
      { skillName: "zeta", score: 2 },
    ]);
    const modes = [
      { id: "zeta", description: "alpha phrase" },
      { id: "beta", description: "alpha phrase" },
    ];
    // …while the mode sibling ties by ID asc — same scores, both surfaces.
    expect(computeModeHints("alpha phrase present", modes)).toEqual([
      { modeId: "beta", score: 2 },
      { modeId: "zeta", score: 2 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — sessions.active_mode + migration 0027
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D3: sessions.activeMode + migration 0027", () => {
  function seedAgentSession(): { agentId: string; sessionId: string } {
    const agent = createAgent(db, {
      name: "R73b Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    return { agentId: agent.id, sessionId: session.id };
  }

  it("a fresh session row has activeMode NULL (the column default — pre-R73 behavior)", () => {
    const { sessionId } = seedAgentSession();
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
    // The column exists on the sessions table (migration 0027).
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("active_mode");
  });

  it("updateSessionActiveMode sets, clears, and round-trips through getSession (unknown id → undefined)", () => {
    const { sessionId } = seedAgentSession();
    expect(updateSessionActiveMode(db, sessionId, "debug")?.activeMode).toBe("debug");
    expect(getSession(db, sessionId)?.activeMode).toBe("debug");
    expect(updateSessionActiveMode(db, sessionId, null)?.activeMode).toBeNull();
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
    expect(updateSessionActiveMode(db, "sess_missing", "debug")).toBeUndefined();
    // Idempotent clear: clearing a modeless session is a no-op write.
    expect(updateSessionActiveMode(db, sessionId, null)?.activeMode).toBeNull();
  });

  it("a fork carries the source session's active task mode (a copy keeps its posture)", () => {
    const { sessionId } = seedAgentSession();
    updateSessionActiveMode(db, sessionId, "plan");
    const fork = forkSession(db, sessionId);
    expect(fork?.activeMode).toBe("plan");
    expect(getSession(db, sessionId)?.activeMode).toBe("plan"); // source untouched
  });

  it("migration 0027: appends switch_mode to template/default rows with read_skill; [] rows, read_skill-less rows, and user curation untouched; idempotent; audited", () => {
    // The house openPre* pattern for ALTER-carrying migrations (0027's ADD
    // COLUMN cannot re-run against an existing column — unlike 0026's
    // pure-UPDATE shape): build the db with migrations ≤ 26 ONLY, hand-seed
    // the agent rows, then openDatabase and let 0027 apply for real.
    const path = join(tempDir, `m0027-${randomUUID()}.db`);
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 26)
      .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
    expect(files).toHaveLength(26);
    const insert = raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const file of files) {
      raw.exec(readFileSync(join(migrationsDir, file), "utf8"));
      insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
    }
    const now = new Date().toISOString();
    const ins = raw.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'none', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const withSkill = JSON.stringify(["list_dir", "read_file", "read_skill"]);
    const noSkill = JSON.stringify(["list_dir", "read_file", "write_file"]);
    const userWithSkill = JSON.stringify(["read_skill", "read_file"]);
    ins.run("agt_tpl_coder", withSkill, 1, now, now);      // template, has read_skill → +1
    ins.run("agt_default_nova", "[]", 0, now, now);        // [] = ALL tools → untouched
    ins.run("agt_tpl_readonly", noSkill, 1, now, now);     // template, no read_skill → untouched
    ins.run("agt_user_skillful", userWithSkill, 0, now, now); // user curation → untouched
    raw.close();

    const reopened = openDatabase(path); // 0027 applies
    const row = (id: string): string[] =>
      JSON.parse(
        (reopened.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string }).allowed_tools,
      ) as string[];

    // Template with read_skill: switch_mode appended at the tail (a
    // mode-capable agent is one that can read skills).
    expect(row("agt_tpl_coder")).toEqual(["list_dir", "read_file", "read_skill", "switch_mode"]);
    // [] row means ALL tools — untouched (the 0019 lesson).
    expect(row("agt_default_nova")).toEqual([]);
    // Template without read_skill: no mode-capable baseline — untouched.
    expect(row("agt_tpl_readonly")).toEqual(["list_dir", "read_file", "write_file"]);
    // User curation: never widened.
    expect(row("agt_user_skillful")).toEqual(["read_skill", "read_file"]);

    // Audit trail + bookkeeping.
    const audit = reopened
      .prepare("SELECT actor, action, decision FROM audit_log WHERE actor = 'migration-0027' LIMIT 1")
      .get() as { actor: string; action: string; decision: string };
    expect(audit).toEqual({ actor: "migration-0027", action: "agent.tools.append", decision: "applied" });
    expect(reopened.prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toBeDefined();

    // Idempotent on reopen.
    reopened.close();
    const again = openDatabase(path);
    expect(
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ) as string[],
    ).toHaveLength(4);
    again.close();
  });

  it("fresh databases seed the templates WITH switch_mode (TOOL_NAMES is the seed — no repair needed)", () => {
    const row = db
      .prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'")
      .get() as { allowed_tools: string };
    expect((JSON.parse(row.allowed_tools) as string[]).includes("switch_mode")).toBe(true);
    expect(TOOL_NAMES.includes("switch_mode")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — routes: PATCH /sessions/:id activeMode + GET /projects/:id/modes
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D4: the routes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
  });

  afterEach(async () => {
    await app.close();
  });

  async function authInject(options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse> {
    return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
  }

  async function routeSession(projectId?: string): Promise<string> {
    const agent = createAgent(db, {
      name: "R73b Route Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const response = await authInject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { agentId: agent.id, mode: "single", ...(projectId !== undefined ? { projectId } : {}) },
    });
    expect(response.statusCode).toBe(202);
    return response.json().id as string;
  }

  it("PATCH activeMode: a valid builtin id persists, the response carries activeMode, and the row round-trips", async () => {
    const sessionId = await routeSession();
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { activeMode: "debug" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().activeMode).toBe("debug");
    expect(getSession(db, sessionId)?.activeMode).toBe("debug");
  });

  it("PATCH activeMode: null CLEARS the mode (and an absent field leaves it untouched)", async () => {
    const sessionId = await routeSession();
    await authInject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, payload: { activeMode: "plan" } });
    // Absent activeMode (a title-only PATCH) → the mode is untouched.
    await authInject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, payload: { title: "Renamed" } });
    expect(getSession(db, sessionId)?.activeMode).toBe("plan");
    // null clears.
    const cleared = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { activeMode: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().activeMode).toBeNull();
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
    // The title-only PATCH did rename.
    expect(getSession(db, sessionId)?.title).toBe("Renamed");
  });

  it("PATCH activeMode: an unknown id is a 400 VALIDATION carrying the available mode ids (and the row is untouched)", async () => {
    const sessionId = await routeSession();
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { activeMode: "yolo" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    const details = response.json().error.details as { field?: string; availableModes?: string[] };
    expect(details.field).toBe("body.activeMode");
    expect(details.availableModes).toContain("plan");
    expect(details.availableModes).toContain("refactor");
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
  });

  it("PATCH activeMode: a non-string/non-null value is a 400; a body with NEITHER field is a 400; unknown session is a 404", async () => {
    const sessionId = await routeSession();
    const badType = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { activeMode: 42 },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error.code).toBe("VALIDATION");

    const empty = await authInject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}`, payload: {} });
    expect(empty.statusCode).toBe(400);

    const missing = await authInject({
      method: "PATCH",
      url: "/api/v1/sessions/sess_missing",
      payload: { activeMode: "debug" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH title + activeMode together: both land (the mode validation happens BEFORE any write)", async () => {
    const sessionId = await routeSession();
    const both = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { title: "Posture switch", activeMode: "review" },
    });
    expect(both.statusCode).toBe(200);
    expect(both.json().title).toBe("Posture switch");
    expect(both.json().activeMode).toBe("review");
    // A BAD mode with a title never renames as a side effect.
    const rejected = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      payload: { title: "Should not land", activeMode: "bogus" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(getSession(db, sessionId)?.title).toBe("Posture switch");
  });

  it("GET /projects/:id/modes: metadata-only shape (id/name/description/source/readOnly — NEVER a body field) + the six builtins in order", async () => {
    const root = mkdtempSync(join(tempDir, "modes-proj-"));
    const project = createProject(db, { name: "R73b Modes Project", rootPath: root });
    const response = await authInject({ method: "GET", url: `/api/v1/projects/${project.id}/modes` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { modes: Array<Record<string, unknown>> };
    expect(body.modes.map((m) => m.id)).toEqual(["plan", "debug", "build", "review", "explore", "refactor"]);
    for (const mode of body.modes) {
      // R75: readOnly (the mode-policy tier) joined the metadata — the
      // picker badges the enforced read-only postures without duplicating
      // the set client-side.
      expect(Object.keys(mode).sort()).toEqual(["description", "id", "name", "readOnly", "source"]);
      expect(mode.source).toBe("builtin");
    }
    // The read-only flags: plan/review/explore true, the rest false.
    const byId = new Map(body.modes.map((m) => [m.id, m.readOnly]));
    expect(byId.get("plan")).toBe(true);
    expect(byId.get("review")).toBe(true);
    expect(byId.get("explore")).toBe(true);
    expect(byId.get("debug")).toBe(false);
    expect(byId.get("build")).toBe(false);
    expect(byId.get("refactor")).toBe(false);
    // The deep bodies are PROMPT-side: never served here.
    expect(JSON.stringify(body)).not.toContain("# Mode: plan");
  });

  it("GET /projects/:id/modes: 404 on an unknown project (the house pattern)", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/projects/prj_missing/modes" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("GET /projects/:id/modes: the project's .acute/agents/*.md customs appear (source 'file'), shadowing a same-id builtin", async () => {
    const root = mkdtempSync(join(tempDir, "custom-modes-proj-"));
    const agentsDir = join(root, ".acute", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "debug.md"),
      "---\nname: Debug\ndescription: Project debug posture.\n---\n# Mode: debug — CUSTOM\n\nProject-specific diagnosis discipline.",
      "utf8",
    );
    writeFileSync(
      join(agentsDir, "ship.md"),
      "---\nname: Ship\n---\n# Mode: ship — RELEASE\n\nThe release posture.",
      "utf8",
    );
    const project = createProject(db, { name: "R73b Custom Modes", rootPath: root });
    const response = await authInject({ method: "GET", url: `/api/v1/projects/${project.id}/modes` });
    const body = response.json() as { modes: Array<{ id: string; source: string; description?: string }> };
    // The custom debug SHADOWS the builtin (ONE entry, custom wins).
    const debugModes = body.modes.filter((m) => m.id === "debug");
    expect(debugModes).toHaveLength(1);
    expect(debugModes[0]?.source).toBe("file");
    // The stem-named custom appears with the honest fallback description.
    const ship = body.modes.find((m) => m.id === "ship");
    expect(ship?.source).toBe("file");
    // Five untouched builtins + 2 customs = 7.
    expect(body.modes).toHaveLength(7);
    // Bodies never ride the route.
    expect(JSON.stringify(body)).not.toContain("CUSTOM");
    // …and the SAME resolver feeds prepareTurn (one truth).
    expect(resolveEffectiveModes(root).modes.map((m) => m.id)).toEqual(body.modes.map((m) => m.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — the switch_mode tool
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D5: the switch_mode tool", () => {
  function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
    return {
      db,
      sessionId: "sess-r73b-decl",
      agentId: "agt-r73b-decl",
      ...overrides,
    };
  }

  async function buildTool(root: string, deps?: ToolDeps) {
    const tools = await modesPlugin.createTools({
      root,
      ...(deps !== undefined ? { toolDeps: deps } : {}),
    });
    return tools.find((t) => t.name === "switch_mode")!;
  }

  it("the plugin declares one tool with the house metadata (deps-gated: bare builds declare nothing)", async () => {
    expect(await modesPlugin.createTools({ root: tempDir })).toHaveLength(0);
    const tools = await modesPlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("switch_mode");
    expect(modesPlugin.id).toBe("core-modes");
    expect(modesPlugin.version).toBe("1.0.0");
    expect(modesPlugin.category).toBe("planning");
    expect(tools[0]?.description).toContain("TASK MODE");
    expect(tools[0]?.description).toContain(".acute/agents/*.md");
  });

  it("no arguments → the index: header, every mode line, the active marker, the usage line", async () => {
    const agent = createAgent(db, {
      name: "R73b Tool Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const tool = await buildTool(tempDir, makeDeps({ sessionId: session.id }));
    const result = await tool.execute({}, { root: tempDir });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Task modes available");
    expect(result.output).toContain("- plan: Plan — ");
    expect(result.output).toContain("- refactor: Refactor — ");
    expect(result.output).toContain("No task mode is currently active (default posture).");
    expect(result.output).toContain('Activate with switch_mode { mode: "<id>" }');
    // With a mode active, the marker names it.
    updateSessionActiveMode(db, session.id, "debug");
    const active = await tool.execute({}, { root: tempDir });
    expect(active.ok).toBe(true);
    expect(active.output).toContain("Currently active: debug (Debug).");
  });

  it("a valid id → '# Task mode ACTIVE:' + the FULL body + the fenced task-mode reminder; the session row is updated", async () => {
    const agent = createAgent(db, {
      name: "R73b Tool Agent 2",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const tool = await buildTool(tempDir, makeDeps({ sessionId: session.id }));
    const result = await tool.execute({ mode: "plan" }, { root: tempDir });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("# Task mode ACTIVE: Plan (plan)")).toBe(true);
    // The full posture body rides verbatim.
    const plan = findMode(resolveEffectiveModes(tempDir).modes, "plan")!;
    expect(result.output).toContain(plan.body);
    // …and the R73-d reminder block (kind "task-mode") closes it.
    expect(result.output).toContain(
      renderReminder({
        kind: "task-mode",
        label: "task mode switched: plan (Plan)",
        text: 'This guide now rides the ACTIVE TASK MODE section of the system prompt every following turn. Deactivate with switch_mode { mode: "none" }.',
      }),
    );
    expect(result.output).toContain("--- (end task mode — the surrounding content is unaffected)");
    // The session row carries the mode.
    expect(getSession(db, session.id)?.activeMode).toBe("plan");
  });

  it("the clear sentinels deactivate honestly — and clearing a modeless session says so (idempotent)", async () => {
    const agent = createAgent(db, {
      name: "R73b Tool Agent 3",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const tool = await buildTool(tempDir, makeDeps({ sessionId: session.id }));
    // Activate, then clear with "none".
    await tool.execute({ mode: "debug" }, { root: tempDir });
    expect(getSession(db, session.id)?.activeMode).toBe("debug");
    const cleared = await tool.execute({ mode: "none" }, { root: tempDir });
    expect(cleared.ok).toBe(true);
    expect(cleared.output).toBe(
      "Task mode deactivated. The ACTIVE TASK MODE section leaves the system prompt from the next turn; default posture applies.",
    );
    expect(getSession(db, session.id)?.activeMode).toBeNull();
    // Idempotent: clearing again is honest about nothing being active.
    const noop = await tool.execute({ mode: "off" }, { root: tempDir });
    expect(noop.ok).toBe(true);
    expect(noop.output).toContain("No task mode was active — nothing to deactivate.");
    // A JSON null is accepted as clear too (lenient schema layers pass it).
    // ROUND-75 (R75): the probe mode here must be NON-read-only — plan/
    // review/explore are OWNER-PINNED (switch_mode cannot leave or clear
    // them; the r75-mode-policy suite pins that refusal). The null-clear
    // contract itself is what this block tests — build carries it.
    await tool.execute({ mode: "build" }, { root: tempDir });
    const viaNull = await tool.execute({ mode: null }, { root: tempDir });
    expect(viaNull.ok).toBe(true);
    expect(getSession(db, session.id)?.activeMode).toBeNull();
  });

  it("an unknown id → ok:false + the available ids + the .acute/agents hint; a non-string mode is refused", async () => {
    const agent = createAgent(db, {
      name: "R73b Tool Agent 4",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const tool = await buildTool(tempDir, makeDeps({ sessionId: session.id }));
    const result = await tool.execute({ mode: "yolo" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no task mode named 'yolo'");
    expect(result.output).toContain("plan, debug, build, review, explore, refactor");
    expect(result.output).toContain(".acute/agents/*.md");
    expect(getSession(db, session.id)?.activeMode).toBeNull();
    const badType = await tool.execute({ mode: 42 }, { root: tempDir });
    expect(badType.ok).toBe(false);
    expect(badType.output).toContain("mode must be a mode id string");
  });

  it("the null-db guard: declaration contexts refuse honestly, never crash", async () => {
    const tool = await buildTool(tempDir, makeDeps({ db: null as unknown as ToolDeps["db"] }));
    const result = await tool.execute({ mode: "plan" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("switch_mode: no database in this context");
  });

  it("a CUSTOM mode id resolves through the project root (frontmatter body + reminder + row)", async () => {
    const root = mkdtempSync(join(tempDir, "custom-tool-proj-"));
    const agentsDir = join(root, ".acute", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "ship.md"),
      "---\nname: Ship\ndescription: The release posture.\n---\n# Mode: ship — RELEASE\n\nCut the release only when green.",
      "utf8",
    );
    const agent = createAgent(db, {
      name: "R73b Tool Agent 5",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const tool = await buildTool(root, makeDeps({ sessionId: session.id }));
    const result = await tool.execute({ mode: "ship" }, { root });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("# Task mode ACTIVE: Ship (ship)")).toBe(true);
    expect(result.output).toContain("Cut the release only when green.");
    expect(getSession(db, session.id)?.activeMode).toBe("ship");
    // The index lists the custom alongside the builtins.
    const index = await tool.execute({}, { root });
    expect(index.output).toContain("- ship: Ship — The release posture.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D6 — runtime integration (the r72-a D3 pattern: system captured on BOTH paths)
// ─────────────────────────────────────────────────────────────────────────────

describe("R73-b D6: prepareTurn threading (both turn paths)", () => {
  function cleanStream(): AsyncGenerator<StreamChatEvent> {
    return (async function* () {
      yield { type: "text-delta", delta: "Done." };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    })();
  }

  interface StreamInputShape {
    system: string;
  }

  async function runStreamedTurnAndCaptureSystem(sessionId: string, content: string): Promise<string> {
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
    const outcome = await runStreamedAgentTurn(deps, sessionId, content, () => undefined);
    expect(outcome.ok).toBe(true);
    return captured.system;
  }

  async function runSyncTurnAndCaptureSystem(sessionId: string, content: string): Promise<string> {
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async (input: { system: string }) => {
        captured.system = input.system;
        return { text: "unused", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
      }) as never,
    };
    const outcome = await runSingleAgentTurn(deps, sessionId, content);
    expect(outcome.ok).toBe(true);
    return captured.system;
  }

  /** A session bound to an agent + a temp project root (custom modes optional). */
  function newSession(projectRoot?: string): string {
    const root = projectRoot ?? mkdtempSync(join(tempDir, "proj-"));
    const project = createProject(db, { name: "R73bWiring", rootPath: root });
    const agent = createAgent(db, {
      name: "R73b Wiring Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
    });
    return createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;
  }

  it("STREAMED path: every project turn carries the TASK MODES index + the mode signal line for the defect message", async () => {
    const sessionId = newSession();
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    expect(system).toContain("## TASK MODES (posture modules — activate with switch_mode)");
    expect(system).toContain("- plan: Plan — ");
    expect(system).toContain("- refactor: Refactor — ");
    expect(system).toMatch(
      /^Task signal: this request looks like the \*\*debug\*\* posture(?: \(and possibly \*\*[a-z-]+\*\*\))? — consider switch_mode(?: \{ mode: "debug" \})? FIRST\.$/m,
    );
    // No mode auto-activated: no ACTIVE TASK MODE section on a modeless session.
    expect(system).not.toContain("## ACTIVE TASK MODE");
  });

  it("STREAMED path: an unrelated message → the index but NO signal line (the matcher stays silent)", async () => {
    const sessionId = newSession();
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "what is the capital of France");
    expect(system).toContain("## TASK MODES");
    expect(system).not.toContain("Task signal:");
  });

  it("SYNC path: the same mode signal threading (parity with the streamed path)", async () => {
    const sessionId = newSession();
    const system = await runSyncTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    expect(system).toContain("## TASK MODES (posture modules — activate with switch_mode)");
    expect(system).toContain("**debug**");
  });

  it("an ACTIVE mode rides the ACTIVE TASK MODE section every turn (body verbatim), on both paths", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "review");
    const streamed = await runStreamedTurnAndCaptureSystem(sessionId, "please check this diff");
    expect(streamed).toContain("## ACTIVE TASK MODE — Review (review)");
    expect(streamed).toContain(findMode(BUILTIN_MODES, "review")!.body);
    expect(streamed).toContain('Clear with switch_mode { mode: "none" }.');
    const synced = await runSyncTurnAndCaptureSystem(sessionId, "and again");
    expect(synced).toContain("## ACTIVE TASK MODE — Review (review)");
    // The ACTIVE section sits after the index.
    expect(synced.indexOf("## ACTIVE TASK MODE")).toBeGreaterThan(synced.indexOf("## TASK MODES"));
  });

  it("a VANISHED custom mode is cleared with the honest one-turn note, and the row is modeless afterwards", async () => {
    const root = mkdtempSync(join(tempDir, "vanish-proj-"));
    const agentsDir = join(root, ".acute", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "custom-debug.md"), "---\nname: Custom Debug\ndescription: A custom debug posture.\n---\n# Mode: custom-debug — CUSTOM", "utf8");
    const sessionId = newSession(root);
    updateSessionActiveMode(db, sessionId, "custom-debug");
    // The mode file disappears before the next turn…
    rmSync(join(agentsDir, "custom-debug.md"));
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "next turn please");
    expect(system).not.toContain("## ACTIVE TASK MODE");
    expect(system).toContain(
      "[task mode 'custom-debug' from a previous turn no longer exists (its .acute/agents file was removed) — active mode cleared]",
    );
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
    // The note is ONE-TURN: the next turn renders neither note nor section.
    const second = await runStreamedTurnAndCaptureSystem(sessionId, "and the next");
    expect(second).not.toContain("active mode cleared");
    expect(second).not.toContain("## ACTIVE TASK MODE");
  });

  it("a custom mode's `tools` frontmatter NARROWS the live toolset (validated against the real registry; empty → NO_TOOLS)", async () => {
    const root = mkdtempSync(join(tempDir, "narrow-proj-"));
    const agentsDir = join(root, ".acute", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "scoped.md"),
      "---\nname: Scoped\ndescription: A narrowed posture.\ntools: read_file, search_code\n---\n# Mode: scoped — NARROW",
      "utf8",
    );
    const sessionId = newSession(root);
    updateSessionActiveMode(db, sessionId, "scoped");
    // The tool-capturing chat (the permission-modes pattern).
    const toolNames: string[][] = [];
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async (input: { tools?: unknown }) => {
        toolNames.push(input.tools !== undefined ? Object.keys(input.tools as object) : []);
        return { text: "scoped done.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
      }) as never,
    };
    const outcome = await runSingleAgentTurn(deps, sessionId, "work under the scoped posture");
    expect(outcome.ok).toBe(true);
    expect(toolNames[0]?.sort()).toEqual(["read_file", "search_code"]);
    // The unit helper: unknown names drop; an all-unknown list → NO_TOOLS;
    // builtins (no tools list) → untouched.
    const builtin = findMode(BUILTIN_MODES, "plan")!;
    expect(narrowAllowListByTaskMode(["read_file", "run_command"], builtin)).toEqual(["read_file", "run_command"]);
    expect(narrowAllowListByTaskMode(undefined, { ...builtin, source: "file", tools: ["read_file"] })).toEqual(["read_file"]);
    expect(narrowAllowListByTaskMode(["read_file"], { ...builtin, source: "file", tools: ["not_a_tool", "read_file"] })).toEqual(["read_file"]);
    expect(narrowAllowListByTaskMode(undefined, { ...builtin, source: "file", tools: ["not_a_tool"] })).toEqual(NO_TOOLS);
    expect(narrowAllowListByTaskMode(["read_file"], undefined)).toEqual(["read_file"]);
    expect(narrowAllowListByTaskMode(undefined, undefined)).toBeUndefined();
    // An empty intersection → the NO_TOOLS sentinel ([] would mean ALL).
    expect(narrowAllowListByTaskMode(["run_command"], { ...builtin, source: "file", tools: ["read_file"] })).toEqual(NO_TOOLS);
  });

  it("the prompt's toolNames reflect the post-intersection set (the honesty rule — switch_mode itself narrows away when not in the mode's list)", async () => {
    const root = mkdtempSync(join(tempDir, "honest-proj-"));
    const agentsDir = join(root, ".acute", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "readonly-mode.md"),
      "---\nname: Readonly Mode\ndescription: Read-only posture.\ntools: read_file, list_dir, switch_mode\n---\n# Mode: readonly-mode — READ",
      "utf8",
    );
    const sessionId = newSession(root);
    updateSessionActiveMode(db, sessionId, "readonly-mode");
    const system = await runSyncTurnAndCaptureSystem(sessionId, "read-only work");
    const toolsLine = system.match(/You have access to these tools: ([^\n]+)\./)?.[1] ?? "";
    expect(toolsLine).toContain("read_file");
    expect(toolsLine).toContain("list_dir");
    expect(toolsLine).toContain("switch_mode");
    expect(toolsLine).not.toContain("run_command");
    expect(toolsLine).not.toContain("write_file");
  });
});
