import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const dir = mkdtempSync(join(tmpdir(), "acute-storage-"));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

interface AgentRow {
  id: string;
  name: string;
  provider_id: string | null;
  model: string | null;
  allowed_tools: string;
  memory_policy: string;
  max_turns: number;
  temperature: number;
  version: number;
  is_template: number;
}

function templateRows(db: SqliteDatabase): AgentRow[] {
  return db
    .prepare("SELECT * FROM agents WHERE is_template = 1 ORDER BY name ASC")
    .all() as AgentRow[];
}

describe("openDatabase", () => {
  it("runs in WAL mode", () => {
    const db = openDatabase(join(dir, "wal.db"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("creates the full schema v1 table set", () => {
    const db = openDatabase(join(dir, "schema.db"));
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "agents",
          "providers",
          "sessions",
          "session_events",
          "usage_events",
          "approvals",
          "audit_log",
          "settings",
          "schema_migrations",
        ]),
      );
      const sessionColumns = (
        db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
      ).map((column) => column.name);
      expect(sessionColumns).toContain("agent_id");
    } finally {
      db.close();
    }
  });

  it("keeps a per-session monotonic seq on the append-only event log", () => {
    const db = openDatabase(join(dir, "events.db"));
    try {
      const insert = db.prepare(
        "INSERT INTO session_events (session_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
      );
      const now = new Date().toISOString();
      insert.run("sess_a", 1, "message.user", "{}", now);
      insert.run("sess_a", 2, "message.assistant", "{}", now);
      insert.run("sess_b", 1, "message.user", "{}", now);
      // The UNIQUE (session_id, seq) constraint rejects seq reuse within a session…
      expect(() => insert.run("sess_a", 2, "message.user", "{}", now)).toThrow();
      // …while other sessions carry their own counters.
      expect(() => insert.run("sess_b", 2, "message.user", "{}", now)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("applies migrations idempotently (reopen does not re-apply or fail)", () => {
    const path = join(dir, "idempotent.db");
    const first = openDatabase(path);
    const appliedFirst = first
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
    first.close();

    const second = openDatabase(path);
    const appliedSecond = second
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
    second.close();

    expect(appliedFirst).toEqual([
      { version: 1, name: "0001_init.sql" },
      { version: 2, name: "0002_sessions_usage.sql" },
      { version: 3, name: "0003_projects.sql" },
      { version: 4, name: "0004_models.sql" },
      { version: 5, name: "0005_snapshots.sql" },
      { version: 6, name: "0006_agents_max_outer_loops.sql" },
      { version: 7, name: "0007_codebase_index.sql" },
      { version: 8, name: "0008_subagents.sql" },
      { version: 9, name: "0009_approvals.sql" },
      { version: 10, name: "0010_provider_tombstones.sql" },
      // ROUND-40: app-level notifications (task complete/failed, permission
      // requests, sub-agent transitions).
      { version: 11, name: "0011_notifications.sql" },
      // ROUND-42: Web Push subscriptions (desktop notifications with the
      // app window closed).
      { version: 12, name: "0012_push_subscriptions.sql" },
      // ROUND-43: default-model refresh — the OpenRouter default was deleted
      // upstream; dead ids are rewritten to the free catalog default.
      { version: 13, name: "0013_default_model_refresh.sql" },
      // ROUND-43: delegate_task + browser_control appended to template/
      // default-agent allowlists (delegation was unreachable from seeds).
      { version: 14, name: "0014_delegate_browser_tools.sql" },
      // ROUND-44 (R44-a): the agent memory system — the project memory
      // table + memory_save/recall/list appended to seed allowlists.
      { version: 15, name: "0015_memory.sql" },
      { version: 16, name: "0016_web_host_rules.sql" },
      // ROUND-46 (R46-d): durable per-project browser-proxy cookie jar
      // (restart-surviving logins for the embedded browser).
      { version: 17, name: "0017_browser_cookies.sql" },
      // ROUND-48 (R48-a): per-project colors — legacy default-color rows
      // backfilled round-robin from the 8-color PROJECT_PALETTE.
      { version: 18, name: "0018_project_colors.sql" },
      // ROUND-49: repairs the default agent allowlist that 0014+0015
      // accidentally narrowed from [] (= ALL tools) to just the appended
      // orchestration/browser/memory tools.
      { version: 19, name: "0019_repair_default_agent_tools.sql" },
      // ROUND-50 (R50-c1, the owner's composer round): per-session permission
      // modes (full|ask|plan|editor, default 'ask') + the cached prompt-token
      // column the context meter's cache-hit-rate line reads.
      { version: 20, name: "0020_permission_modes_attachments.sql" },
      // ROUND-52 (R52-a): job_status + job_stop appended to template/default
      // allowlists that include run_command (background-command supervision).
      { version: 21, name: "0021_background_job_tools.sql" },
      // ROUND-59 (R59-D): the response-rating table — good|bad per assistant
      // reply with the frozen turn-context snapshot (no FK on sessions).
      { version: 22, name: "0022_message_ratings.sql" },
      // ROUND-61 (R61): computer use — models.supports_vision column + the
      // skills + mcp_servers tables (the computer-use tools themselves are
      // settings-gated, default OFF; no agent allowlist was touched).
      { version: 23, name: "0023_computer_use.sql" },
      // ROUND-64 (R64-e): the per-API-key usage dimension — key_slot on
      // usage_events (0 = primary; pool slots = sub-agent children).
      { version: 24, name: "0024_usage_key_slot.sql" },
      // ROUND-66 (R66-2-b): the vision settings split — vision.mode/
      // provider/modelId seeded from the R61 computerUse.vision.* rows.
      { version: 25, name: "0025_vision_settings.sql" },
      // ROUND-66 (R66): analyze_image joins TOOL_NAMES — appended to
      // template/default allowlists that include web_fetch.
      { version: 26, name: "0026_analyze_image_tool.sql" },
      // ROUND-73 (R73-b): the task-modes round — sessions.active_mode
      // column (NULL = default posture) + switch_mode appended to
      // template/default allowlists that include read_skill.
      { version: 27, name: "0027_task_modes.sql" },
      // ROUND-79 (R79-a, the orchestrator round): the addressable-delegation
      // tier — sessions.delegate_task_id column (NULL = unaddressed child,
      // the pre-R79 behavior) + the idx_sessions_parent_task index for the
      // duplicate/cap/guard lookups. No allowlist curation (delegate_task
      // gained parameters, not a new tool name).
      { version: 28, name: "0028_delegation_task_id.sql" },
      // ROUND-81 (R81, the unified mode picker): data-only mapping that
      // keeps the R75 read-only guarantee after enforcement moved to the
      // permission tier — editor permission_mode → ask (fail-closed),
      // read-only R75 postures (active_mode plan/review/explore) →
      // permission 'plan'; active_mode kept as the posture pointer.
      { version: 29, name: "0029_unified_modes.sql" },
      // ROUND-82 (R82, the model-edit dialog's proper capability options):
      // NULLABLE tri-state columns supports_tools/supports_audio/
      // supports_video on models (NULL = unknown, 0 = off, 1 = on — the
      // 0004 NOT NULL DEFAULT 0 columns conflated "false" with "unknown").
      // The catalog backfill is code-side (db.ts →
      // backfillModelCapabilities, openrouter-scoped).
      { version: 30, name: "0030_model_capabilities.sql" },
      // ROUND-83 (R83, honest metering): usage_events gains provider_calls
      // (the REAL SDK-call count behind a turn — DEFAULT 1 keeps every
      // pre-R83 row exactly true) + origin (turn | compaction | debug —
      // the hidden-call rows) + the origin index.
      { version: 31, name: "0031_usage_calls_origin.sql" },
      // ROUND-87 (R87): the model input/output capability columns
      // (supports_pdf + the four *_output flags + size_label).
      { version: 32, name: "0032_model_io_capabilities.sql" },
      // ROUND-87 (R87): ask_user joins the allowlist vocabulary —
      // appended to template/default rows by the companion rule.
      { version: 33, name: "0033_ask_user_tool.sql" },
      { version: 34, name: "0034_computer_element_map.sql" },
      // ROUND-95 (R95-B, the per-model thinking-level detection): the
      // models.reasoning_support JSON-blob column (null = unknown — the
      // honest default until a reasoning-capable catalog merge touches the
      // row; the runtime never blocks on it).
      { version: 35, name: "0035_model_reasoning_support.sql" },
    ]);
    expect(appliedSecond).toEqual(appliedFirst);
  });
});

describe("template seeding", () => {
  it("seeds the five templates with the agreed defaults on first run", () => {
    const db = openDatabase(join(dir, "seed.db"));
    try {
      const rows = templateRows(db);
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.name)).toEqual([
        "Coder",
        "Planner",
        "Researcher",
        "Reviewer",
        "Tester",
      ]);
      for (const row of rows) {
        expect(row.id).toMatch(/^agt_tpl_/);
        expect(row.provider_id).toBeNull();
        expect(row.model).toBeNull();
        expect(JSON.parse(row.allowed_tools)).toEqual([
          "list_dir",
          "read_file",
          "write_file",
          "edit_file",
          "create_dir",
          "delete_file",
          "search_files",
          "search_code",
          "git_status",
          "git_diff",
          "git_log",
          "run_command",
          "todo_write",
          "web_fetch",
          "web_search",
          "index_project",
          "delegate_task",
          "browser_control",
          // ROUND-44 (R44-a): the memory tools (seeded via TOOL_NAMES).
          "memory_save",
          "memory_recall",
          "memory_list",
          // ROUND-52 (R52-a): the background-job supervision tools (seeded
          // via TOOL_NAMES — companions of run_command above).
          "job_status",
          "job_stop",
          // ROUND-61 (R61): the skills loader — a GLOBAL capability seeded
          // via TOOL_NAMES (existing DBs get it appended by migration 0023;
          // the computer-use tools are deliberately NOT here: they are the
          // settings-gated surface, not allowlist vocabulary).
          "read_skill",
          // ROUND-66 (R66, B3): the general image-analysis tool — seeded via
          // TOOL_NAMES (existing DBs get it appended by migration 0026).
          "analyze_image",
          // ROUND-73 (R73-b): the task-mode posture switch — seeded via
          // TOOL_NAMES (existing DBs get it appended by migration 0027).
          "switch_mode",
          // ROUND-87 (R87): the mid-task interactive question tool — seeded
          // via TOOL_NAMES (existing DBs get it appended by migration 0033).
          "ask_user",
        ]);
        expect(row.memory_policy).toBe("on-start");
        expect(row.max_turns).toBe(40);
        expect(row.temperature).toBe(0.2);
        expect(row.version).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("seeds exactly once across reopens (no duplicates)", () => {
    const path = join(dir, "seed-once.db");
    openDatabase(path).close();
    const db = openDatabase(path);
    try {
      expect(templateRows(db)).toHaveLength(5);
      const { total } = db.prepare("SELECT COUNT(*) AS total FROM agents").get() as {
        total: number;
      };
      // 5 templates + the round-15 plug-and-play default agent (Nova).
      expect(total).toBe(6);
    } finally {
      db.close();
    }
  });
});
