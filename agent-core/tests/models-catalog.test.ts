/**
 * ROUND-43 (R43-3 / task 6-b): the built-in model catalog + migration 0013.
 *
 * The old default (stealth/ox-alpha) was deleted upstream by OpenRouter and
 * killed every chat that referenced it. These tests pin the replacement
 * catalog (free + notable paid, real snapshot pricing/ctx/capabilities), the
 * DEFAULT_MODEL_ID, the shared free-only filter helpers, and the conservative
 * dead-id repair migration for existing databases.
 */
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  DEFAULT_MODEL_ID,
  FREE_MODEL_CATALOG,
  MODEL_CATALOG,
  PAID_MODEL_CATALOG,
  RECOMMENDED_MODEL_IDS,
  SUBAGENT_DEFAULT_MODEL_ID,
  filterCatalogByFreeOnly,
  getCatalogModel,
  isFreeModelId,
  isKnownCatalogModelId,
  orderCatalogRecommended,
} from "../src/storage/models";

const dir = mkdtempSync(join(tmpdir(), "acute-models-catalog-"));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

const KEY_FREE_IDS = [
  DEFAULT_MODEL_ID,
  "minimax/minimax-m3:free",
  "thinkingmachines/inkling-small:free",
  SUBAGENT_DEFAULT_MODEL_ID,
  "poolside/laguna-s-2.1:free",
  "cohere/north-mini-code:free",
  "openrouter/free",
] as const;

describe("built-in model catalog (round-43)", () => {
  it("contains the researched key free ids (default + alternates + meta-router)", () => {
    const ids = new Set(MODEL_CATALOG.map((m) => m.modelId));
    for (const id of KEY_FREE_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("ships every current :free snapshot id plus the openrouter/free router (18 chat-capable free entries)", () => {
    // 17 ids ending :free in the 2026-08-26 snapshot + the openrouter/free
    // meta-router (the two zero-priced google/lyria-* are music generation,
    // not chat — excluded by design).
    expect(FREE_MODEL_CATALOG).toHaveLength(18);
    expect(FREE_MODEL_CATALOG.filter((m) => m.modelId.endsWith(":free"))).toHaveLength(17);
    expect(getCatalogModel("openrouter/free")?.free).toBe(true);
  });

  it("gives every free entry $0 pricing and a real context window", () => {
    expect(FREE_MODEL_CATALOG.length).toBeGreaterThan(0);
    for (const m of FREE_MODEL_CATALOG) {
      expect(m.free).toBe(true);
      expect(m.inputPricePerMtok).toBe(0);
      expect(m.outputPricePerMtok).toBe(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it("carries the real snapshot context windows for the key picks", () => {
    expect(getCatalogModel(DEFAULT_MODEL_ID)).toMatchObject({
      contextWindow: 256_000,
      supportsTools: true,
      supportsStructuredOutputs: true,
      free: true,
    });
    expect(getCatalogModel("minimax/minimax-m3:free")?.contextWindow).toBe(1_048_576);
    expect(getCatalogModel(SUBAGENT_DEFAULT_MODEL_ID)).toMatchObject({
      contextWindow: 1_000_000,
      supportsTools: true,
    });
    expect(getCatalogModel("thinkingmachines/inkling-small:free")?.contextWindow).toBe(1_048_576);
    expect(getCatalogModel("poolside/laguna-s-2.1:free")?.contextWindow).toBe(262_144);
    expect(getCatalogModel("cohere/north-mini-code:free")?.contextWindow).toBe(256_000);
  });

  it("marks tool support per the snapshot (default + alternates tool-capable; content-safety is not)", () => {
    for (const id of KEY_FREE_IDS) {
      expect(getCatalogModel(id)?.supportsTools, id).toBe(true);
    }
    // nemotron-3.5-content-safety has NO tools in supported_parameters.
    expect(getCatalogModel("nvidia/nemotron-3.5-content-safety:free")?.supportsTools).toBe(false);
  });

  it("ships a paid side with real (>0) snapshot pricing and no free rows", () => {
    expect(PAID_MODEL_CATALOG.length).toBeGreaterThanOrEqual(25);
    for (const m of PAID_MODEL_CATALOG) {
      expect(m.free).toBe(false);
      expect(m.inputPricePerMtok).toBeGreaterThan(0);
      expect(m.outputPricePerMtok).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
    // Spot-check real prices (USD per 1M tokens, snapshot 2026-08-26).
    expect(getCatalogModel("anthropic/claude-opus-4.5")).toMatchObject({
      inputPricePerMtok: 5,
      outputPricePerMtok: 25,
    });
    expect(getCatalogModel("openai/gpt-4o-mini")).toMatchObject({
      inputPricePerMtok: 0.15,
      outputPricePerMtok: 0.6,
    });
  });

  it("defaults to the free GLM 5.2 and pins the recommended order", () => {
    expect(DEFAULT_MODEL_ID).toBe("z-ai/glm-5.2:free");
    expect(RECOMMENDED_MODEL_IDS[0]).toBe(DEFAULT_MODEL_ID);
    expect(RECOMMENDED_MODEL_IDS).toEqual(KEY_FREE_IDS);
    for (const id of RECOMMENDED_MODEL_IDS) {
      expect(isKnownCatalogModelId(id), id).toBe(true);
    }
  });
});

describe("catalog helpers", () => {
  it("isFreeModelId: :free suffix, meta-router, $0 price, catalog rows", () => {
    expect(isFreeModelId("z-ai/glm-5.2:free")).toBe(true);
    expect(isFreeModelId("anything/unknown:free")).toBe(true);
    expect(isFreeModelId("openrouter/free")).toBe(true);
    expect(isFreeModelId("some/local-model", 0)).toBe(true);
    expect(isFreeModelId("openai/gpt-4o")).toBe(false);
    expect(isFreeModelId("openai/gpt-4o", 2.5)).toBe(false);
  });

  it("filterCatalogByFreeOnly keeps only free rows when on, everything when off", () => {
    const rows = [
      { modelId: "z-ai/glm-5.2:free", inputPricePerMtok: 0 },
      { modelId: "openai/gpt-4o", inputPricePerMtok: 2.5 },
      { modelId: "custom/local", inputPricePerMtok: null },
    ];
    expect(filterCatalogByFreeOnly(rows, true).map((r) => r.modelId)).toEqual(["z-ai/glm-5.2:free"]);
    expect(filterCatalogByFreeOnly(rows, false)).toHaveLength(3);
  });

  it("orderCatalogRecommended pins recommended first, free next, paid last", () => {
    const ordered = orderCatalogRecommended(
      [...MODEL_CATALOG].sort(() => Math.random() - 0.5).map((m) => ({ modelId: m.modelId, free: m.free })),
    );
    expect(ordered.slice(0, RECOMMENDED_MODEL_IDS.length).map((m) => m.modelId)).toEqual([
      ...RECOMMENDED_MODEL_IDS,
    ]);
    const freeBlock = ordered.slice(RECOMMENDED_MODEL_IDS.length);
    const firstPaid = freeBlock.findIndex((m) => m.free === false);
    if (firstPaid !== -1) {
      // every row after the first paid row must also be paid
      expect(freeBlock.slice(firstPaid).every((m) => m.free === false)).toBe(true);
      expect(freeBlock.slice(0, firstPaid).every((m) => m.free === true)).toBe(true);
    }
  });
});

/* ── Migration 0013: dead-id → default repair on existing databases ───────── */

/** Applies migrations 0001..0012 by hand — simulates a pre-round-43 install. */
function openPreR43Database(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 12)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(12);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return db;
}

interface AgentModelRow {
  id: string;
  model: string | null;
  provider_id: string | null;
}

function agentModels(db: SqliteDatabase): AgentModelRow[] {
  return db
    .prepare("SELECT id, model, provider_id FROM agents ORDER BY id")
    .all() as AgentModelRow[];
}

describe("migration 0013 (default model refresh)", () => {
  it("rewrites dead OpenRouter model ids to the new free default, conservatively", () => {
    const path = join(dir, "dead-model.db");
    const old = openPreR43Database(path);
    const now = new Date().toISOString();
    // Real installs always carry the seeded openrouter provider row (it is
    // FK-referenced by the models override rows below).
    old
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1',
           'chat-completions', 1, ?)`,
      )
      .run(now);
    const insertAgent = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', '', '', ?, ?, NULL, '[]', 'none', '[]', 40, 5, 0.2, 1, 0, ?, ?)`,
    );
    insertAgent.run("agt_dead", "openrouter", "stealth/ox-alpha", now, now); // the dead default
    insertAgent.run("agt_dead_openrouter_prefix", "openrouter", "openrouter/ox-alpha", now, now);
    insertAgent.run("agt_free_kept", "openrouter", "z-ai/glm-5.2:free", now, now);
    insertAgent.run("agt_unknown_free_kept", "openrouter", "vendor/newcomer:free", now, now);
    insertAgent.run("agt_paid_kept", "openrouter", "anthropic/claude-sonnet-4.5", now, now);
    insertAgent.run("agt_custom_provider_kept", "prv_ollama", "llama3:8b", now, now);
    insertAgent.run("agt_custom_dead_kept", "prv_gateway", "stealth/ox-alpha", now, now);
    old
      .prepare(
        `INSERT INTO models (id, provider_id, model_id, display_name, context_window,
           max_output_tokens, input_price_per_mtok, input_price_cached_per_mtok,
           output_price_per_mtok, supports_thinking, hidden, sort_order, created_at, updated_at)
         VALUES ('mdl_dead', 'openrouter', 'stealth/ox-alpha', 'dead', 1048576, NULL,
           0, NULL, 0, 0, 0, 0, ?, ?)`,
      )
      .run(now, now);
    old
      .prepare(
        `INSERT INTO models (id, provider_id, model_id, display_name, context_window,
           max_output_tokens, input_price_per_mtok, input_price_cached_per_mtok,
           output_price_per_mtok, supports_thinking, hidden, sort_order, created_at, updated_at)
         VALUES ('mdl_override_kept', 'openrouter', 'openai/gpt-4o', '4o', 128000, NULL,
           2.5, NULL, 10, 0, 0, 0, ?, ?)`,
      )
      .run(now, now);
    old.close();

    // Reopen with the current code: 0013 applies inside openDatabase.
    const db = openDatabase(path);
    try {
      const byId = new Map(agentModels(db).map((r) => [r.id, r.model]));
      expect(byId.get("agt_dead")).toBe(DEFAULT_MODEL_ID);
      expect(byId.get("agt_dead_openrouter_prefix")).toBe(DEFAULT_MODEL_ID);
      expect(byId.get("agt_free_kept")).toBe("z-ai/glm-5.2:free");
      expect(byId.get("agt_unknown_free_kept")).toBe("vendor/newcomer:free"); // :free never rewritten
      expect(byId.get("agt_paid_kept")).toBe("anthropic/claude-sonnet-4.5"); // catalog id kept
      expect(byId.get("agt_custom_provider_kept")).toBe("llama3:8b"); // custom provider untouched
      expect(byId.get("agt_custom_dead_kept")).toBe("stealth/ox-alpha"); // not openrouter-scoped

      const modelIds = (
        db.prepare("SELECT model_id FROM models ORDER BY model_id").all() as { model_id: string }[]
      ).map((r) => r.model_id);
      expect(modelIds).not.toContain("stealth/ox-alpha"); // known-dead override removed
      expect(modelIds).toContain("openai/gpt-4o"); // unrelated override preserved

      // ROUND-43 note: migration 0014 also writes an audit row on reopen —
      // assert 0013's OWN row exists rather than "the latest row".
      const audit = db
        .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0013' LIMIT 1")
        .get() as { actor: string; action: string };
      expect(audit).toEqual({ actor: "migration-0013", action: "model.default.refresh" });

      const applied = db
        .prepare("SELECT version FROM schema_migrations WHERE version = 13")
        .get();
      expect(applied).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("seeds fresh installs on the new free default (no dead id anywhere)", () => {
    const db = openDatabase(join(dir, "fresh-default.db"));
    try {
      const nova = db
        .prepare("SELECT model FROM agents WHERE id = 'agt_default_nova'")
        .get() as { model: string };
      expect(nova.model).toBe(DEFAULT_MODEL_ID);
      const { total } = db
        .prepare("SELECT COUNT(*) AS total FROM agents WHERE model = 'stealth/ox-alpha'")
        .get() as { total: number };
      expect(total).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("migration 0014 (delegate_task + browser_control allowlist repair)", () => {
  it("appends the orchestration tools to template/default rows, skips users' custom agents, idempotent", () => {
    const path = join(dir, "m0014-tools.db");
    const old = openPreR43Database(path);
    const now = new Date().toISOString();
    old
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1',
           'chat-completions', 1, ?)`,
      )
      .run(now);
    const ins = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'none', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const seedTools = JSON.stringify([
      "list_dir", "read_file", "write_file", "edit_file", "create_dir", "delete_file",
      "search_files", "search_code", "git_status", "git_diff", "git_log", "run_command",
      "todo_write", "web_fetch", "web_search", "index_project",
    ]);
    ins.run("agt_tpl_coder", seedTools, 1, now, now);               // template, old shape
    ins.run("agt_default_nova", seedTools, 0, now, now);            // default agent, old shape
    ins.run("agt_mine", seedTools, 0, now, now);                    // user-created: untouched
    ins.run(
      "agt_tpl_already",
      JSON.stringify(["list_dir", "delegate_task", "browser_control"]),
      1,
      now,
      now,
    );                                                               // already has them
    old.close();

    const db = openDatabase(path); // 0013 + 0014 + 0015 (R44-a) apply
    const row = (id: string) =>
      JSON.parse(
        (db.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string }).allowed_tools,
      ) as string[];
    expect(row("agt_tpl_coder")).toContain("delegate_task");
    expect(row("agt_tpl_coder")).toContain("browser_control");
    // ROUND-44 (R44-a): 0015 appends the memory tools on top of 0014's 18;
    // ROUND-52 (R52-a): 0021 appends the two job tools (the seed list
    // includes run_command) → 23; ROUND-61 (R61): 0023 appends read_skill
    // (the skills loader is a global capability) → 24; ROUND-66 (R66):
    // 0026 appends analyze_image (the seed list includes web_fetch) → 25;
    // ROUND-73 (R73-b): 0027 appends switch_mode (the read_skill companion
    // rule — the list has read_skill by then) → 26; ROUND-87 (R87): 0033
    // appends ask_user (the todo_write companion rule — the list has
    // todo_write by then) → 27 — and ROUND-96's migration 0036 appends
    // search_skills (the read_skill companion rule) → 28.
    expect(row("agt_tpl_coder")).toHaveLength(28);
    expect(row("agt_tpl_coder")).toContain("analyze_image");
    expect(row("agt_default_nova")).toContain("delegate_task");
    expect(row("agt_default_nova")).toContain("browser_control");
    expect(row("agt_mine")).toEqual(JSON.parse(seedTools)); // untouched
    // ROUND-44 (R44-a): the "already has them" template ALSO gets the
    // memory tools appended by 0015 (it is a template row). ROUND-52
    // (R52-a): migration 0021 leaves it UNTOUCHED — its list has no
    // run_command, and the job tools are companions to run_command.
    // ROUND-61 (R61): migration 0023 appends read_skill (it is a template
    // row with a non-empty list). ROUND-66 (R66): 0026 leaves it UNTOUCHED
    // — its list has no web_fetch (the general-capability companion rule).
    // ROUND-73 (R73-b): 0027 appends switch_mode (the mode-capable
    // companion rule — the row HAS read_skill). ROUND-96 (R96-D): 0036
    // appends search_skills (the skills-discovery companion rule — the
    // row HAS read_skill).
    expect(row("agt_tpl_already")).toEqual([
      "list_dir",
      "delegate_task",
      "browser_control",
      "memory_save",
      "memory_recall",
      "memory_list",
      "read_skill",
      "switch_mode",
      "search_skills",
    ]);
    // idempotent on reopen
    db.close();
    const again = openDatabase(path);
    expect(
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ),
    ).toHaveLength(28); // R96: +search_skills (migration 0036)
    again.close();
  });
});


// ── ROUND-62 (D4): per-side pricing — partial price data costs what the
// KNOWN sides cost (the pre-R62 either-null → $0 gate is the defect behind
// "unable to configure the per million input and output token price").
describe("computeCost (R62 per-side pricing)", () => {
  it("input-only pricing costs the input side (not a hard $0); output-only mirrors it; both-null stays $0", async () => {
    const { computeCost } = await import("../src/agents/runtime.js");
    const db = openDatabase(":memory:");
    // A provider + a models row with ONLY the input price set.
    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
       VALUES ('prov-p', 'P', 'openai-compatible', 'https://p.example', 'chat-completions', 1, '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO models (provider_id, model_id, input_price_per_mtok, output_price_per_mtok, created_at, updated_at) VALUES ('prov-p', 'in-only', 3.0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO models (provider_id, model_id, input_price_per_mtok, output_price_per_mtok, created_at, updated_at) VALUES ('prov-p', 'out-only', NULL, 5.0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO models (provider_id, model_id, input_price_per_mtok, output_price_per_mtok, created_at, updated_at) VALUES ('prov-p', 'none', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run();
    // 2M input + 1M output tokens.
    expect(computeCost(db, "prov-p", "in-only", 2_000_000, 1_000_000)).toBeCloseTo(6.0);
    expect(computeCost(db, "prov-p", "out-only", 2_000_000, 1_000_000)).toBeCloseTo(5.0);
    expect(computeCost(db, "prov-p", "none", 2_000_000, 1_000_000)).toBe(0);
    db.close();
  });
});
