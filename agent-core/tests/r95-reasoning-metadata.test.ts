/**
 * ROUND-95 (R95-B, owner: "By just directly checking it, it does not give the
 * actual error message which I got" + "Our program should be able to properly
 * detect the models' thinking options, like which options it supports and
 * such") — the per-model REASONING metadata + the provider-test error detail.
 *
 * Coverage:
 *  · migration 0035: fresh databases get the reasoning_support column;
 *    a PRE-R95 database upgrades in place (existing rows keep their data and
 *    read reasoningSupport null — unknown, never blocking).
 *  · storage round-trip: upsertModel tri-state contract (undefined keeps,
 *    null clears, value sets — canonically serialized: deduped +
 *    vocabulary-ordered), and the defensive read (corrupt JSON / wrong
 *    shape / out-of-vocabulary efforts → null or filtered, never a throw).
 *  · resolveModelReasoningSupport (THE E-CONTRACT): stored value, null for
 *    unknown rows, null for no row at all.
 *  · API validation: POST /providers/:id/models + PATCH /models/:id accept
 *    reasoningSupport (null or {supported, efforts} within the shared
 *    vocabulary); a raw provider ladder value ("none") is a 400 naming the
 *    field — normalization happens at the catalog-merge edge only.
 *  · live-catalog detection: GET /providers/:id/models parses OpenRouter's
 *    supported_parameters/reasoning fields (normalized: xhigh/max kept
 *    VERBATIM per R96-F, none dropped; default_effort parsed), merges onto
 *    existing NULL rows (owner-set rows never touched), and leaves providers
 *    without the metadata UNKNOWN.
 *  · add-model prefill: POST /providers/:id/models prefills reasoningSupport
 *    from the live catalog for NEW rows only (existing rows keep their
 *    stored value on absent); a failed catalog fetch never fails the add.
 *  · normalizeReasoningEfforts unit pins.
 *  · provider-test reachability detail: a 401/500 WITH a JSON error body
 *    surfaces the provider's actual message (scrubbed); a non-JSON body
 *    keeps the old bare message.
 *
 * Style: providers.test.ts route patterns + storage.test.ts direct-storage
 * patterns + migration-0029.test.ts's hand-applied-migrations upgrade check.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import Database from "better-sqlite3";
import { ProviderKeyring, clearModelCache, normalizeReasoningEfforts } from "../src/providers/registry";
// ROUND-96 (R96-F): the models-config route's legacy auto-refresh cooldown
// map is module-level state — reset it between tests like the model cache.
import { clearLegacyReasoningRefreshState } from "../src/routes/providers";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProviderRecord } from "../src/storage/providers";
import {
  getModel,
  resolveModelReasoningSupport,
  upsertModel,
} from "../src/storage/models";
import { buildServer } from "../src/server";
// ROUND-95 (R95-B): shared owns the wire vocabulary — pinned here so the two
// packages can never drift apart.
import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from "shared";

const TOKEN = "test-token-r95b";
const KEY = "sk-or-vtest-r95b";
const GW_ID = "prv_gw_r95";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  clearModelCache();
  clearLegacyReasoningRefreshState();
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r95b-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: "https://gw.example.test/v1" });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** An OpenRouter-shaped /models body: the reasoning-capable entry mirrors the
 * live 2026-09 catalog (supported_parameters + reasoning.supported_efforts
 * carrying the WIDER ladder: max/xhigh/none), the plain entry carries only
 * the parameter list, and the NIM-shaped entry carries neither. */
function openRouterModelsPayload(): Record<string, unknown> {
  return {
    data: [
      {
        id: "test/reasoner",
        name: "Test Reasoner",
        supported_parameters: ["max_tokens", "reasoning", "tools"],
        reasoning: {
          mandatory: false,
          default_enabled: true,
          supported_efforts: ["max", "xhigh", "high", "medium", "low"],
          default_effort: "high",
        },
      },
      {
        id: "test/plain-reasoning",
        name: "Plain Reasoning",
        supported_parameters: ["reasoning", "temperature"],
        reasoning: { mandatory: true },
      },
      {
        id: "test/no-reasoning",
        supported_parameters: ["max_tokens", "temperature"],
      },
      { id: "test/nim-shape", name: "NIM Shape" },
      "junk-entry",
    ],
  };
}

describe("shared vocabulary (the wire contract)", () => {
  it("pins REASONING_EFFORT_LEVELS to the SIX wire-side values, lowest → highest", () => {
    // ROUND-96 (R96-F): xhigh + max joined — the model's OWN rungs are kept
    // verbatim (the owner: "I tested a model which supported high and max but
    // it apparently did not detect that properly").
    expect(REASONING_EFFORT_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("normalizeReasoningEfforts (the catalog-merge edge)", () => {
  it("keeps xhigh/max VERBATIM, drops none + unrecognized values, deduped + ordered", () => {
    expect(normalizeReasoningEfforts(["max", "xhigh", "high", "medium", "low"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // The owner's model (deepseek-v4.1-flash, live 2026-09-13) survives
    // verbatim — NOT folded to [low, high].
    expect(normalizeReasoningEfforts(["max", "high", "low"])).toEqual(["low", "high", "max"]);
    expect(normalizeReasoningEfforts(["xhigh", "high"])).toEqual(["high", "xhigh"]);
    expect(normalizeReasoningEfforts(["high", "none"])).toEqual(["high"]);
    expect(normalizeReasoningEfforts(["ultra", "minimal"])).toEqual(["minimal"]);
    expect(normalizeReasoningEfforts(["high", "high", "low"])).toEqual(["low", "high"]);
    expect(normalizeReasoningEfforts([])).toEqual([]);
  });
});

describe("migration 0035 (per-model reasoning support)", () => {
  it("fresh databases get the reasoning_support column and record the migration", () => {
    const fresh = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const columns = (
        fresh.prepare("PRAGMA table_info(models)").all() as { name: string }[]
      ).map((column) => column.name);
      expect(columns).toContain("reasoning_support");
      expect(
        fresh.prepare("SELECT version FROM schema_migrations WHERE version = 35").get(),
      ).toBeDefined();
    } finally {
      fresh.close();
    }
  });

  it("UPGRADES a pre-R95 database in place: existing rows keep their data + read reasoningSupport null (unknown)", () => {
    const path = join(tempDir, `m0035-${randomUUID()}.db`);
    // Apply 0001..0034 by hand — a pre-R95 install (migration-0029 pattern).
    const old = new Database(path);
    old.pragma("journal_mode = WAL");
    old.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 34)
      .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
    expect(files).toHaveLength(34);
    const record = old.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (const file of files) {
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      record.run(Number(file.slice(0, 4)), file, new Date().toISOString());
    }
    // A provider row + a configured model row from before the round.
    const now = new Date().toISOString();
    old.prepare(
      `INSERT INTO providers (id, name, kind, base_url, created_at)
       VALUES ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1', ?)`,
    ).run(now);
    old.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, created_at, updated_at)
       VALUES ('mdl_pre95', 'openrouter', 'pre95/model-x', 'Pre-95 Model', ?, ?)`,
    ).run(now, now);
    old.close();

    const upgraded = openDatabase(path);
    try {
      // The upgrade applied exactly the new migration.
      expect(
        (upgraded.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
          .map((row) => row.version)
          .includes(35),
      ).toBe(true);
      // The pre-existing row SURVIVED and reads UNKNOWN — never blocking.
      const row = upgraded.prepare(
        "SELECT display_name, reasoning_support FROM models WHERE id = 'mdl_pre95'",
      ).get() as { display_name: string; reasoning_support: string | null };
      expect(row.display_name).toBe("Pre-95 Model");
      expect(row.reasoning_support).toBeNull();
      expect(resolveModelReasoningSupport(upgraded, "openrouter", "pre95/model-x")).toBeNull();
    } finally {
      upgraded.close();
    }
  });
});

describe("R95-B: storage round-trip (the reasoning_support contract)", () => {
  it("INSERT with a value stores the canonical blob and serves it back", () => {
    const row = upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["low", "medium", "high"] },
    });
    expect(row.reasoningSupport).toEqual({ supported: true, efforts: ["low", "medium", "high"] });
    const raw = db
      .prepare("SELECT reasoning_support FROM models WHERE id = ?")
      .get(row.id) as { reasoning_support: string };
    expect(JSON.parse(raw.reasoning_support)).toEqual({
      supported: true,
      efforts: ["low", "medium", "high"],
    });
  });

  it("serializes canonically: direct-storage values are deduped + vocabulary-ordered (xhigh KEPT — R96-F)", () => {
    // A deliberate out-of-vocabulary effort fed STRAIGHT to the storage layer
    // (the route gate 400s these — this pins the deeper defensive contract):
    // the cast stands in for a hand-edited database / non-route caller.
    // ROUND-96 (R96-F): "xhigh" is IN the vocabulary now — kept verbatim.
    const rawEfforts = ["high", "low", "high", "xhigh"] as unknown as ReasoningEffortLevel[];
    const row = upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: rawEfforts },
    });
    expect(row.reasoningSupport).toEqual({ supported: true, efforts: ["low", "high", "xhigh"] });
  });

  it("INSERT without the field starts UNKNOWN (the honest default)", () => {
    const row = upsertModel(db, "openrouter", { modelId: "test/fresh" });
    expect(row.reasoningSupport).toBeNull();
  });

  it("UPDATE ladder: undefined KEEPS, null CLEARS, a value SETS (the R50-d contract)", () => {
    const first = upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["high"] },
    });
    // The INSERT itself stored the blob (not just the echo).
    expect(first.reasoningSupport).toEqual({ supported: true, efforts: ["high"] });
    // absent → keep
    const kept = upsertModel(db, "openrouter", { modelId: "test/reasoner", hidden: true });
    expect(kept.reasoningSupport).toEqual({ supported: true, efforts: ["high"] });
    // null → clear to unknown
    const cleared = upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: null,
    });
    expect(cleared.reasoningSupport).toBeNull();
    // value → set
    const set = upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: false, efforts: [] },
    });
    expect(set.reasoningSupport).toEqual({ supported: false, efforts: [] });
  });

  it("reads defensively: corrupt JSON, wrong shape, and out-of-vocabulary efforts never throw", () => {
    const row = upsertModel(db, "openrouter", { modelId: "test/corrupt" });
    const update = db.prepare("UPDATE models SET reasoning_support = ? WHERE id = ?");
    // Corrupt JSON → unknown.
    update.run("{not json", row.id);
    expect(getModel(db, row.id)?.reasoningSupport).toBeNull();
    // Shape-invalid (supported not a boolean) → unknown.
    update.run(JSON.stringify({ supported: "yes", efforts: [] }), row.id);
    expect(getModel(db, row.id)?.reasoningSupport).toBeNull();
    // Out-of-vocabulary efforts are dropped, not trusted.
    update.run(JSON.stringify({ supported: true, efforts: ["ultra", "high"] }), row.id);
    expect(getModel(db, row.id)?.reasoningSupport).toEqual({ supported: true, efforts: ["high"] });
    // Empty string (an accidental write) → unknown.
    update.run("", row.id);
    expect(getModel(db, row.id)?.reasoningSupport).toBeNull();
  });

  it("resolveModelReasoningSupport (THE E-CONTRACT): stored value / unknown row / no row", () => {
    upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["low", "high"] },
    });
    upsertModel(db, "openrouter", { modelId: "test/undetected" });
    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toEqual({
      supported: true,
      efforts: ["low", "high"],
    });
    // Row without metadata → null (unknown — the runtime falls back to the
    // global thinking-level selector, never blocks).
    expect(resolveModelReasoningSupport(db, "openrouter", "test/undetected")).toBeNull();
    // No row at all → null.
    expect(resolveModelReasoningSupport(db, "openrouter", "never/configured")).toBeNull();
    expect(resolveModelReasoningSupport(db, "no-such-provider", "test/reasoner")).toBeNull();
  });
});

describe("R95-B: API validation (POST /providers/:id/models + PATCH /models/:id)", () => {
  it("POST accepts a good reasoningSupport, persists it, and echoes it in the 201", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: {
        modelId: "test/reasoner",
        reasoningSupport: { supported: true, efforts: ["medium", "high"] },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().reasoningSupport).toEqual({ supported: true, efforts: ["medium", "high"] });
    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toEqual({
      supported: true,
      efforts: ["medium", "high"],
    });
  });

  it("POST accepts null (explicit clear-to-unknown)", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["high"] },
    });
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/reasoner", reasoningSupport: null },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().reasoningSupport).toBeNull();
    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toBeNull();
  });

  it("POST 400s a malformed value naming the field — never a silent drop", async () => {
    for (const bad of [
      "high", // a bare string
      { supported: "yes", efforts: [] }, // supported not a boolean
      { supported: true, efforts: "high" }, // efforts not an array
      { supported: true }, // efforts missing
      { supported: true, efforts: ["none"] }, // RAW disable switch — must be
      { supported: true, efforts: ["ultra"] }, // normalized first (R96-F:
      { supported: true, efforts: [42] }, // xhigh/max ARE accepted now)
      { supported: true, efforts: [], defaultEffort: "none" }, // a disable
      { supported: true, efforts: [], defaultEffort: "ultra" }, // switch / junk
      { supported: true, efforts: [], defaultEffort: 42 }, // is never a default
    ]) {
      const response = await authInject({
        method: "POST",
        url: "/api/v1/providers/openrouter/models",
        payload: { modelId: "test/bad-reasoning", reasoningSupport: bad },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("VALIDATION");
      expect(body.error.details.field).toBe("body.reasoningSupport");
      expect(body.error.message).toContain("reasoningSupport must be null or");
    }
  });

  it("PATCH sets, clears, and keeps the blob (the same tri-state contract)", async () => {
    const created = upsertModel(db, "openrouter", { modelId: "test/reasoner" });
    const set = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${created.id}`,
      payload: { reasoningSupport: { supported: true, efforts: ["low", "medium"] } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().reasoningSupport).toEqual({ supported: true, efforts: ["low", "medium"] });

    // Absent field → the stored value is untouched.
    const kept = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${created.id}`,
      payload: { hidden: true },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().reasoningSupport).toEqual({ supported: true, efforts: ["low", "medium"] });

    // null → clears back to unknown.
    const cleared = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${created.id}`,
      payload: { reasoningSupport: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().reasoningSupport).toBeNull();
  });

  it("PATCH 400s a malformed value with the same field + message", async () => {
    const created = upsertModel(db, "openrouter", { modelId: "test/reasoner" });
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${created.id}`,
      payload: { reasoningSupport: { supported: true, efforts: ["ultra"] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.field).toBe("body.reasoningSupport");
  });

  it("GET /providers/:id/models-config serves the field on every row (additive)", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["high"] },
    });
    upsertModel(db, "openrouter", { modelId: "test/plain" });
    // ROUND-96 (R96-F): the route now runs the legacy auto-refresh when a
    // NULL-reasoning row is served — stub the catalog (no live calls in
    // unit tests; an empty catalog merges nothing, pinning the honest
    // unchanged serve).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{ modelId: string; reasoningSupport: unknown }>;
    expect(models.find((m) => m.modelId === "test/reasoner")?.reasoningSupport).toEqual({
      supported: true,
      efforts: ["high"],
    });
    expect(models.find((m) => m.modelId === "test/plain")?.reasoningSupport).toBeNull();
  });
});

describe("R95-B: live-catalog detection (GET /providers/:id/models)", () => {
  it("parses + normalizes OpenRouter's reasoning metadata and serves it additively", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          new Response(JSON.stringify(openRouterModelsPayload()), { status: 200 }),
      ),
    );
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models",
    });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{
      id: string;
      reasoningSupport?: { supported: boolean; efforts: string[]; defaultEffort?: string };
    }>;
    // ROUND-96 (R96-F): the wide ladder (max/xhigh/…) survives VERBATIM and
    // the published default rides along.
    expect(models.find((m) => m.id === "test/reasoner")?.reasoningSupport).toEqual({
      supported: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    // Plain reasoning-only entry: supported, empty ladder.
    expect(models.find((m) => m.id === "test/plain-reasoning")?.reasoningSupport).toEqual({
      supported: true,
      efforts: [],
    });
    // The catalog says NO reasoning → an explicit false verdict.
    expect(models.find((m) => m.id === "test/no-reasoning")?.reasoningSupport).toEqual({
      supported: false,
      efforts: [],
    });
    // The NIM-shaped entry (no metadata) carries NO field — unknown.
    expect(models.find((m) => m.id === "test/nim-shape")?.reasoningSupport).toBeUndefined();
  });

  it("merges detected capability onto EXISTING null rows (owner-set rows never touched)", async () => {
    upsertModel(db, "openrouter", { modelId: "test/reasoner" }); // NULL → merged
    upsertModel(db, "openrouter", {
      modelId: "test/no-reasoning",
    }); // NULL → merged (false verdict)
    upsertModel(db, "openrouter", { modelId: "test/nim-shape" }); // no metadata → stays null
    const ownerSet = upsertModel(db, "openrouter", {
      modelId: "test/plain-reasoning",
      reasoningSupport: { supported: true, efforts: ["minimal"] }, // owner-set → kept
    });
    expect(ownerSet.reasoningSupport).toEqual({ supported: true, efforts: ["minimal"] });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          new Response(JSON.stringify(openRouterModelsPayload()), { status: 200 }),
      ),
    );
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models",
    });
    expect(response.statusCode).toBe(200);

    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toEqual({
      supported: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    expect(resolveModelReasoningSupport(db, "openrouter", "test/no-reasoning")).toEqual({
      supported: false,
      efforts: [],
    });
    // No metadata in the catalog → the row stays UNKNOWN (never "unsupported").
    expect(resolveModelReasoningSupport(db, "openrouter", "test/nim-shape")).toBeNull();
    // The owner-set row is never clobbered by the catalog.
    expect(resolveModelReasoningSupport(db, "openrouter", "test/plain-reasoning")).toEqual({
      supported: true,
      efforts: ["minimal"],
    });

    // Idempotent: a second (cached) fetch changes nothing.
    const again = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models",
    });
    expect(again.statusCode).toBe(200);
    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toEqual({
      supported: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

  it("scopes the merge to the fetched provider — a gateway row sharing the id inherits NOTHING", async () => {
    // A gateway row with the SAME model-id string as the OpenRouter entry.
    upsertModel(db, GW_ID, { modelId: "test/reasoner" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          // The gateway's OWN catalog carries no reasoning metadata (NIM shape).
          new Response(JSON.stringify({ data: [{ id: "test/reasoner", name: "GW copy" }] }), {
            status: 200,
          }),
      ),
    );
    const response = await authInject({ method: "GET", url: `/api/v1/providers/${GW_ID}/models` });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{ reasoningSupport?: unknown }>;
    expect(models[0].reasoningSupport).toBeUndefined();
    expect(resolveModelReasoningSupport(db, GW_ID, "test/reasoner")).toBeNull();
  });
});

describe("R95-B: add-model prefill (POST /providers/:id/models)", () => {
  it("prefills reasoningSupport from the LIVE catalog for a NEW row when the body omits it", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(JSON.stringify(openRouterModelsPayload()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/reasoner" },
    });
    expect(response.statusCode).toBe(201);
    // Detected + normalized from the live catalog (R96-F: verbatim ladder
    // + the published default).
    expect(response.json().reasoningSupport).toEqual({
      supported: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    expect(resolveModelReasoningSupport(db, "openrouter", "test/reasoner")).toEqual({
      supported: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    // The detection used the catalog fetch.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps the STORED value when an EXISTING row is re-added without the field", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/reasoner",
      reasoningSupport: { supported: true, efforts: ["minimal"] },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          new Response(JSON.stringify(openRouterModelsPayload()), { status: 200 }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/reasoner", contextWindow: 123000 },
    });
    expect(response.statusCode).toBe(201);
    // The owner's stored blob survived the re-add (R50-d keep contract).
    expect(response.json().reasoningSupport).toEqual({ supported: true, efforts: ["minimal"] });
    // …while the re-added pricing field DID update.
    expect(response.json().contextWindow).toBe(123000);
  });

  it("an explicit body value beats detection; a FAILED catalog fetch never fails the add", async () => {
    // Explicit value wins over the catalog.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          new Response(JSON.stringify(openRouterModelsPayload()), { status: 200 }),
      ),
    );
    const explicit = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: {
        modelId: "test/reasoner",
        reasoningSupport: { supported: false, efforts: [] },
      },
    });
    expect(explicit.statusCode).toBe(201);
    expect(explicit.json().reasoningSupport).toEqual({ supported: false, efforts: [] });

    // The upstream catalog is unreachable → the add still succeeds, unknown.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const offline = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/offline-add" },
    });
    expect(offline.statusCode).toBe(201);
    expect(offline.json().reasoningSupport).toBeNull();
  });
});

describe("R95-B: provider-test reachability now surfaces the upstream error body", () => {
  it("no model + HTTP 401 with a JSON error body: the message carries the provider's actual text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "User key cvca-4f8e9d2b3a is invalid" } }),
            { status: 401 },
          ),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("key rejected by provider (HTTP 401)");
    expect(body.message).toContain("User key cvca-4f8e9d2b3a is invalid");
  });

  it("no model + HTTP 500 with a JSON error body: the 502 message names the status AND the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "upstream overloaded — retry later" } }), {
            status: 500,
          }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PROVIDER_ERROR");
    expect(response.json().error.message).toContain("HTTP 500");
    expect(response.json().error.message).toContain("upstream overloaded — retry later");
  });

  it("no model + a NON-JSON body: the message stays the old bare form (no crash, no fake detail)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe("key rejected by provider (HTTP 401)");
  });

  it("the surfaced detail is scrubbed of the key value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: `key ${KEY} was rejected` } }), {
            status: 403,
          }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const message = String(response.json().message);
    expect(message).not.toContain(KEY);
    expect(message).toContain("***");
  });
});
