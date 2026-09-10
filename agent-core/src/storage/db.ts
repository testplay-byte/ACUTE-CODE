/**
 * SQLite entry point (ADR-0007): better-sqlite3, WAL mode, numbered plain-SQL
 * migrations recorded in schema_migrations, one-time template + built-in
 * provider seeding.
 * This module (and the repositories next to it) is the only code that issues SQL.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { TOOL_NAMES, type Agent } from "./agents.js";
import { ensureDefaultAgent } from "./agents.js";
import { seedBuiltinProviders } from "./providers.js";
// ROUND-82 (R82): the 0030 capability backfill — catalog tools bits onto
// openrouter rows still NULL (unknown). Idempotent; runs after migrations.
import { backfillModelCapabilities } from "./models.js";
import { seedBuiltinSkills } from "./skills.js";

export type SqliteDatabase = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL("migrations", import.meta.url));
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

function applyMigrations(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Pick<MigrationRow, "version">[]).map(
      (row) => row.version,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .map((file) => MIGRATION_FILE.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0]));
  for (const match of files) {
    const version = Number(match[1]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, match[0]), "utf8");
    // One transaction per file: schema change + bookkeeping row commit together.
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        version,
        match[0],
        new Date().toISOString(),
      );
    })();
  }
}

/** Five seeded templates (SPEC §F2; ARCHITECTURE §3.3 agents/): never hard-coded elsewhere. */
const TEMPLATE_AGENTS: ReadonlyArray<
  Pick<Agent, "id" | "name" | "role" | "systemPrompt"> & { allowedTools: readonly string[] }
> = [
  {
    id: "agt_tpl_planner",
    name: "Planner",
    role: "planner",
    systemPrompt:
      "You break work into small, verifiable steps. Produce a concise plan with clear task " +
      "boundaries, the files each task touches, and acceptance criteria per task. " +
      "You never write implementation code yourself.",
    allowedTools: TOOL_NAMES,
  },
  {
    id: "agt_tpl_researcher",
    name: "Researcher",
    role: "researcher",
    systemPrompt:
      "You investigate the codebase and external references and gather exactly what is needed " +
      "for the task. Report findings with file paths and concrete evidence; " +
      "flag uncertainty explicitly instead of speculating.",
    allowedTools: TOOL_NAMES,
  },
  {
    id: "agt_tpl_coder",
    name: "Coder",
    role: "coder",
    systemPrompt:
      "You write precise, minimal diffs that implement exactly the assigned task. " +
      "Follow existing project conventions, prefer the smallest change that works, " +
      "and never expand scope beyond the task.",
    allowedTools: TOOL_NAMES,
  },
  {
    id: "agt_tpl_reviewer",
    name: "Reviewer",
    role: "reviewer",
    systemPrompt:
      "You review diffs for correctness, security, and clarity. Be specific: cite the file and " +
      "location, state the severity of each finding, and propose the minimal fix. " +
      "Approve only when no blocking findings remain.",
    allowedTools: TOOL_NAMES,
  },
  {
    id: "agt_tpl_tester",
    name: "Tester",
    role: "tester",
    systemPrompt:
      "You design and run tests that prove the task's acceptance criteria. Cover the failure " +
      "case first, keep suites fast and deterministic, and report exact reproduction steps " +
      "for anything that fails.",
    allowedTools: TOOL_NAMES,
  },
];

function seedTemplates(db: SqliteDatabase): void {
  db.transaction(() => {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE is_template = 1")
      .get() as { count: number };
    if (count > 0) return;
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, vision_model,
      allowed_tools, memory_policy, skills, max_turns, temperature,
      version, is_template, created_at, updated_at
    ) VALUES (
      @id, @name, @role, @systemPrompt, NULL, NULL, NULL,
      @allowedTools, @memoryPolicy, @skills, @maxTurns, @temperature,
      1, 1, @now, @now
    )`);
    for (const template of TEMPLATE_AGENTS) {
      insert.run({
        id: template.id,
        name: template.name,
        role: template.role,
        systemPrompt: template.systemPrompt,
        allowedTools: JSON.stringify(template.allowedTools),
        memoryPolicy: "on-start",
        skills: JSON.stringify([]),
        maxTurns: 40,
        temperature: 0.2,
        now,
      });
    }
  })();
}

/**
 * Opens (creating if needed) the database, applies pending migrations, seeds
 * templates and the built-in provider rows (openrouter, SPEC §F4) once.
 */
export function openDatabase(path: string): SqliteDatabase {
  // The shell normally creates the app-data dir; be robust when spawned standalone.
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  seedTemplates(db);
  seedBuiltinProviders(db);
  // ROUND-82 (R82): the 0030 model-capability backfill — catalog
  // supportsTools bits onto openrouter-scoped rows whose columns are still
  // NULL. Idempotent (NULL-guarded WHERE): a second open is a no-op.
  backfillModelCapabilities(db);
  // ROUND-61: built-in skills seed once per open (INSERT OR IGNORE — user
  // edits persist; deletion of built-ins is refused in skills.ts).
  seedBuiltinSkills(db);
  ensureDefaultAgent(db);
  return db;
}
