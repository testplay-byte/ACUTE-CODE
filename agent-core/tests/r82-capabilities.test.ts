/**
 * ROUND-82 (R82, owner: "when editing the models … proper options … vision,
 * audio, video" capability support selection) — the NULLABLE tri-state
 * capability columns (migration 0030: supports_tools / supports_audio /
 * supports_video; NULL = unknown, 0 = off, 1 = on).
 *
 * The defect this pins: the 0004-era columns (supports_thinking /
 * supports_vision) are NOT NULL DEFAULT 0 — "false" and "unknown" are
 * conflated, so a NIM/custom row (which no catalog source ever sets) renders
 * as OFF when the truth is "unknown". The new columns never conflate.
 *
 * Coverage:
 *  · upsertModel tri-state contract: INSERT prefill (catalog supportsTools
 *    for known ids; NULL for unknown ids), explicit booleans, and the
 *    UPDATE ladder — undefined KEEPS, null CLEARS to unknown, boolean SETS
 *    (the numeric fields' R50-d null-clearing contract, applied to the
 *    capability columns).
 *  · POST /providers/:id/models + PATCH /models/:id accept tri-states
 *    (boolean or null); a wrong type 400s with the honest message
 *    "a boolean or null (unknown)".
 *  · backfillModelCapabilities: openrouter-scoped (a custom-provider row
 *    with the SAME model_id inherits NOTHING — the catalog describes
 *    OpenRouter-hosted variants), NULL-guarded (user-set rows never
 *    touched), and idempotent (a second run is a no-op).
 *  · GET /models/configured: every configured row across ALL providers
 *    (the Sub-agents picker's per-provider section — §2.4.5).
 *
 * Style: providers.test.ts route patterns + storage.test.ts direct-storage
 * patterns.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProviderRecord } from "../src/storage/providers";
import {
  DEFAULT_MODEL_ID,
  SUBAGENT_DEFAULT_MODEL_ID,
  backfillModelCapabilities,
  listModels,
  upsertModel,
} from "../src/storage/models";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r82cap";
const KEY = "sk-or-vtest-r82cap";
const GW_ID = "prv_gw";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r82cap-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: "https://gw.example.test/v1" });
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
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

describe("R82: upsertModel tri-state round-trip (the storage contract)", () => {
  it("INSERT prefill: a CATALOG-known id gets the catalog's supportsTools; audio/video stay unknown", () => {
    // The app-wide default is a tools-capable catalog entry.
    const row = upsertModel(db, "openrouter", { modelId: DEFAULT_MODEL_ID });
    expect(row.supportsTools).toBe(true);
    // No catalog source exists for audio/video — the honest unknown.
    expect(row.supportsAudio).toBeNull();
    expect(row.supportsVideo).toBeNull();
    // …and listModels serves the same tri-states back.
    expect(listModels(db, "openrouter").find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools).toBe(true);
  });

  it("INSERT prefill: an UNKNOWN id (NIM/custom shape) starts all-unknown — never the 0004-era silent false", () => {
    const row = upsertModel(db, GW_ID, { modelId: "meta/llama-3.1-70b-instruct" });
    expect(row.supportsTools).toBeNull();
    expect(row.supportsAudio).toBeNull();
    expect(row.supportsVideo).toBeNull();
  });

  it("INSERT with EXPLICIT booleans: the explicit value beats the catalog prefill", () => {
    const row = upsertModel(db, "openrouter", {
      modelId: DEFAULT_MODEL_ID,
      supportsTools: false,
      supportsAudio: true,
    });
    // The explicit boolean beats the catalog prefill (the default model's
    // catalog bit is true)…
    expect(row.supportsTools).toBe(false);
    expect(row.supportsAudio).toBe(true);
    // …and a field the caller never mentioned stays unknown.
    expect(row.supportsVideo).toBeNull();
    // NOTE (R82-TESTS, REAL BUG — see the POST-route pin below): an EXPLICIT
    // null on INSERT is stored as 0 (false) rather than NULL (unknown),
    // contradicting ModelInput's own docblock ("null RESETS to unknown"),
    // the route's 400 message ("a boolean or null (unknown)"), and the
    // R50-d numeric precedent (`input.x ?? null` keeps null on INSERT).
    // The bug is pinned at the ROUTE level in the describe below; the src
    // is frozen, so it is left failing there per the test mandate.
  });

  it("UPDATE ladder: undefined KEEPS, null CLEARS to unknown, boolean SETS (the R50-d contract)", () => {
    upsertModel(db, GW_ID, {
      modelId: "meta/llama-3.1-70b-instruct",
      supportsTools: true,
      supportsAudio: false,
      supportsVideo: true,
    });

    // (1) Absent fields keep the stored values.
    const kept = upsertModel(db, GW_ID, { modelId: "meta/llama-3.1-70b-instruct", displayName: "Llama" });
    expect(kept).toMatchObject({ supportsTools: true, supportsAudio: false, supportsVideo: true });

    // (2) null clears back to unknown.
    const cleared = upsertModel(db, GW_ID, {
      modelId: "meta/llama-3.1-70b-instruct",
      supportsTools: null,
    });
    expect(cleared.supportsTools).toBeNull();
    expect(cleared.supportsAudio).toBe(false); // untouched
    expect(cleared.supportsVideo).toBe(true); // untouched

    // (3) a boolean sets.
    const set = upsertModel(db, GW_ID, {
      modelId: "meta/llama-3.1-70b-instruct",
      supportsAudio: true,
      supportsVideo: false,
    });
    expect(set).toMatchObject({ supportsTools: null, supportsAudio: true, supportsVideo: false });
  });
});

describe("R82: POST /providers/:id/models + PATCH /models/:id tri-state wire contract", () => {
  // REAL BUG (R82, found by R82-TESTS — src frozen, left FAILING per the
  // test mandate): POST /providers/:id/models accepts an explicit null (the
  // 400 gate's own message promises "a boolean or null (unknown)", and
  // ModelInput's docblock says "null RESETS to unknown" — the R50-d numeric
  // null-clearing contract the tri-states explicitly invoke)… but
  // upsertModel's INSERT branch maps null to 0 (FALSE):
  // `input.supportsAudio !== undefined ? input.supportsAudio === true ? 1 : 0 : null`
  // — a two-way ternary for a three-way value. The client says "unknown"
  // and the row records "off" — precisely the 0004-era false/unknown
  // conflation migration 0030 exists to remove, surviving on the INSERT
  // path. Not reachable from the shipped UI (the dialog PATCHes; the
  // add-models flows send no capability fields), API-only. Fix for the R82
  // close-out: `input.x === undefined ? <prefill|null> : input.x === null ? null : input.x ? 1 : 0`.
  it("POST accepts booleans AND null on the way in — null records UNKNOWN, never false", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/tri-model", supportsTools: true, supportsAudio: null, supportsVideo: false },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      modelId: "test/tri-model",
      supportsTools: true,
      // The declared contract: null = unknown (NULL column), not false.
      supportsAudio: null,
      supportsVideo: false,
    });
  });

  it("POST without the new fields: unknown id → all three unknown (never silent false)", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/nim-row" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      supportsTools: null,
      supportsAudio: null,
      supportsVideo: null,
    });
  });

  it("PATCH: boolean sets, null clears to unknown, absent keeps", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/tri-patch", supportsTools: true },
    });
    const rowId = created.json().id as string;

    const setFalse = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { supportsTools: false },
    });
    expect(setFalse.statusCode).toBe(200);
    expect(setFalse.json().supportsTools).toBe(false);

    const cleared = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { supportsTools: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().supportsTools).toBeNull();

    // Absent field: the null survives (no reset).
    const kept = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { displayName: "Still unknown" },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().supportsTools).toBeNull();
  });

  it("a WRONG type on a tri-state field is the honest 400 'a boolean or null (unknown)'", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/tri-bad" },
    });
    const rowId = created.json().id as string;

    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { supportsTools: "yes" },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.code).toBe("VALIDATION");
    expect(patched.json().error.message).toContain("a boolean or null (unknown)");
    expect(patched.json().error.details.field).toBe("body.supportsTools");

    // The POST route has the same honest gate.
    const posted = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/tri-bad-2", supportsAudio: 1 },
    });
    expect(posted.statusCode).toBe(400);
    expect(posted.json().error.message).toContain("a boolean or null (unknown)");
    expect(posted.json().error.details.field).toBe("body.supportsAudio");
  });
});

describe("R82: backfillModelCapabilities (0030, openrouter-scoped + idempotent)", () => {
  /** A models row with RAW NULL capability columns (the pre-backfill state
   * 0030 created by ALTERing the table of an existing install). */
  function insertRawRow(providerId: string, modelId: string): void {
    db.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, context_window, max_output_tokens,
         input_price_per_mtok, input_price_cached_per_mtok, output_price_per_mtok,
         supports_thinking, supports_vision, supports_tools, supports_audio, supports_video,
         hidden, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, 0, 0, ?, ?)`,
    ).run(
      `mdl_${randomUUID()}`,
      providerId,
      modelId,
      modelId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  it("fills NULL openrouter rows from the catalog — and NEVER touches same-id rows on other providers", () => {
    // The same catalog model id configured under openrouter AND a custom
    // gateway (the cross-provider collision the scoping exists for).
    insertRawRow("openrouter", DEFAULT_MODEL_ID);
    insertRawRow(GW_ID, DEFAULT_MODEL_ID);
    // A second NULL openrouter row for a tool-LESS catalog entry.
    insertRawRow("openrouter", "nvidia/nemotron-3.5-content-safety:free");

    backfillModelCapabilities(db);

    // OpenRouter rows get the catalog bits…
    expect(listModels(db, "openrouter").find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools).toBe(true);
    expect(
      listModels(db, "openrouter").find((m) => m.modelId === "nvidia/nemotron-3.5-content-safety:free")
        ?.supportsTools,
    ).toBe(false);
    // …the custom-provider row with the SAME model_id stays unknown (the
    // catalog describes OpenRouter-hosted variants — a NIM row sharing the
    // id string must not inherit OpenRouter's metadata).
    expect(listModels(db, GW_ID).find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools).toBeNull();
    // Audio/video have NO catalog source — every row keeps unknown.
    const openrouterRow = listModels(db, "openrouter").find((m) => m.modelId === DEFAULT_MODEL_ID)!;
    expect(openrouterRow.supportsAudio).toBeNull();
    expect(openrouterRow.supportsVideo).toBeNull();
  });

  it("is idempotent (a second run is a no-op) and never overwrites a user-set value", () => {
    insertRawRow("openrouter", DEFAULT_MODEL_ID);
    // A user has explicitly set the gateway's copy to OFF (not unknown)…
    upsertModel(db, GW_ID, { modelId: DEFAULT_MODEL_ID, supportsTools: false });
    // …and set openrouter's SUBAGENT default explicitly too.
    upsertModel(db, "openrouter", { modelId: SUBAGENT_DEFAULT_MODEL_ID, supportsTools: false });

    backfillModelCapabilities(db);
    const first = listModels(db, "openrouter").find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools;
    expect(first).toBe(true); // the NULL row was backfilled

    // Force the backfilled row back to NULL, then re-run: it fills again
    // (still NULL-guarded on the COLUMN, not "touched once" bookkeeping)…
    upsertModel(db, "openrouter", { modelId: DEFAULT_MODEL_ID, supportsTools: null });
    backfillModelCapabilities(db);
    expect(listModels(db, "openrouter").find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools).toBe(true);

    // …but user-SET rows are never overwritten (the WHERE NULL guard):
    // the explicit false on the sub-agent default stays false, and the
    // gateway's explicit false stays false (not catalog-prefilled to true).
    expect(
      listModels(db, "openrouter").find((m) => m.modelId === SUBAGENT_DEFAULT_MODEL_ID)?.supportsTools,
    ).toBe(false);
    expect(listModels(db, GW_ID).find((m) => m.modelId === DEFAULT_MODEL_ID)?.supportsTools).toBe(false);
  });
});

describe("R82: GET /api/v1/models/configured (the §2.4.5 picker feed)", () => {
  it("lists configured rows across ALL providers, ordered provider-then-model", async () => {
    upsertModel(db, "openrouter", { modelId: "z-ai/other-model" });
    upsertModel(db, GW_ID, { modelId: "meta/llama-3.1-70b-instruct", supportsTools: true });
    upsertModel(db, "openrouter", { modelId: "z-ai/another-model" });
    // The seeded nvidia built-in row set (no rows until the owner adds) —
    // the cross-provider pair above is the point.

    const response = await authInject({ method: "GET", url: "/api/v1/models/configured" });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{ providerId: string; modelId: string }>;
    // A NON-openrouter configured row is listed — the pre-R82 pickers were
    // catalog-only (NIM rows could never be sub-agent models).
    expect(models).toContainEqual(
      expect.objectContaining({ providerId: GW_ID, modelId: "meta/llama-3.1-70b-instruct" }),
    );
    expect(models).toContainEqual(expect.objectContaining({ providerId: "openrouter", modelId: "z-ai/other-model" }));
    // Ordered by provider id then model id.
    const keys = models.map((m) => `${m.providerId}/${m.modelId}`);
    expect(keys).toEqual([...keys].sort());
    // Tri-states ride the payload (the picker renders Unknown honestly).
    const gwRow = models.find((m) => m.providerId === GW_ID)!;
    expect(gwRow).toMatchObject({ supportsTools: true, supportsAudio: null, supportsVideo: null });
  });
});
