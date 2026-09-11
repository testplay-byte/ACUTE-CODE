/**
 * ROUND-87 (R87, owner: "In the About section there will be options to reset
 * the whole application. All the things of the application will be reset: the
 * projects, the data, the storage … The providers and models will be removed
 * completely too.") — the POST /system/reset route + the R87 model
 * input/output capability columns (migration 0032).
 *
 * Coverage:
 *  · POST /system/reset: wipes every user table (projects, sessions, models,
 *    custom providers) + reseeds the factory state (templates, builtin
 *    provider rows, builtin skills, the default agent) + clears the
 *    in-memory keyring (a provider test right after reset 409s) + VACUUMs.
 *  · Migration 0032: the R87 capability columns (supports_pdf,
 *    supports_text_output, supports_image_output, supports_video_output,
 *    supports_audio_output — tri-state; size_label — nullable text) flow
 *    through the upsert + PATCH gates with the R50-d null-clearing contract.
 *  · The INSERT defaults: text output ON (the chat-completions contract),
 *    pdf/image/video/audio output UNKNOWN (null).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProviderRecord, listProviderRecords } from "../src/storage/providers";
import { listModels, upsertModel } from "../src/storage/models";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r87";
const GW_ID = "prv_gw";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r87-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: "https://gw.example.test/v1" });
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

function req(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const inject: Record<string, unknown> = { method, url, headers: { authorization: `Bearer ${TOKEN}` } };
  if (body !== undefined) inject.payload = body;
  return app.inject(inject as never);
}

describe("R87 model input/output capability columns", () => {
  it("INSERT defaults: text output ON, pdf/image/video/audio output unknown, size label null", () => {
    const model = upsertModel(db, GW_ID, { modelId: "test/model-a" });
    expect(model.supportsTextOutput).toBe(true);
    expect(model.supportsPdf).toBeNull();
    expect(model.supportsImageOutput).toBeNull();
    expect(model.supportsVideoOutput).toBeNull();
    expect(model.supportsAudioOutput).toBeNull();
    expect(model.sizeLabel).toBeNull();
  });

  it("explicit values round-trip through the upsert + the UPDATE keep/clear ladder", () => {
    const model = upsertModel(db, GW_ID, {
      modelId: "test/model-b",
      supportsPdf: true,
      supportsImageOutput: true,
      supportsTextOutput: false,
      sizeLabel: "70B",
    });
    expect(model.supportsPdf).toBe(true);
    expect(model.supportsImageOutput).toBe(true);
    expect(model.supportsTextOutput).toBe(false);
    expect(model.sizeLabel).toBe("70B");

    // undefined keeps, null clears (R50-d).
    const kept = upsertModel(db, GW_ID, { modelId: "test/model-b", supportsVideoOutput: true });
    expect(kept.supportsPdf).toBe(true);
    expect(kept.supportsVideoOutput).toBe(true);
    const cleared = upsertModel(db, GW_ID, { modelId: "test/model-b", supportsPdf: null, sizeLabel: null });
    expect(cleared.supportsPdf).toBeNull();
    expect(cleared.sizeLabel).toBeNull();
    // sizeLabel null-clear vs empty-string normalization.
    const normalized = upsertModel(db, GW_ID, { modelId: "test/model-b", sizeLabel: "  405B MoE  " });
    expect(normalized.sizeLabel).toBe("405B MoE");
  });

  it("POST /providers/:id/models accepts the R87 fields; wrong types 400", async () => {
    const ok = await req("POST", "/api/v1/providers/prv_gw/models", {
      modelId: "test/model-c",
      supportsPdf: true,
      supportsAudioOutput: false,
      sizeLabel: "8B",
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().supportsPdf).toBe(true);
    expect(ok.json().supportsAudioOutput).toBe(false);
    expect(ok.json().sizeLabel).toBe("8B");

    const bad = await req("POST", "/api/v1/providers/prv_gw/models", {
      modelId: "test/model-d",
      supportsPdf: "yes",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("supportsPdf must be a boolean or null (unknown)");

    const badLabel = await req("POST", "/api/v1/providers/prv_gw/models", {
      modelId: "test/model-e",
      sizeLabel: 70,
    });
    expect(badLabel.statusCode).toBe(400);
    expect(badLabel.json().error.message).toContain("sizeLabel must be a string");
  });

  it("PATCH /models/:id: tri-state contract + null clears the size label", async () => {
    const created = await req("POST", "/api/v1/providers/prv_gw/models", {
      modelId: "test/model-f",
      sizeLabel: "70B",
      supportsVideoOutput: true,
    });
    const id = created.json().id;
    const patched = await req("PATCH", `/api/v1/models/${id}`, {
      supportsPdf: true,
      supportsTextOutput: false,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().supportsPdf).toBe(true);
    expect(patched.json().supportsTextOutput).toBe(false);
    expect(patched.json().supportsVideoOutput).toBe(true);
    expect(patched.json().sizeLabel).toBe("70B");

    const cleared = await req("PATCH", `/api/v1/models/${id}`, { sizeLabel: null, supportsVideoOutput: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().sizeLabel).toBeNull();
    expect(cleared.json().supportsVideoOutput).toBeNull();
  });
});

describe("R87 POST /system/reset", () => {
  it("wipes user data, reseeds factory state, clears the keyring, and reports the sweep", async () => {
    // Arrange: custom provider + model rows + a project + a session + a key
    // in the running keyring (as the spawn env would have injected).
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-v1-live" });
    app = buildServer({ token: TOKEN, db, keyring });
    await req("POST", "/api/v1/providers/prv_gw/models", { modelId: "test/model-x" });
    const project = await req("POST", "/api/v1/projects", { name: "Reset Me", rootPath: tempDir });
    expect(project.statusCode).toBe(201);
    const session = await req("POST", "/api/v1/sessions", { mode: "single", agentId: "agt_default_nova", projectId: project.json().id, title: "s" });
    expect(session.statusCode).toBe(202);
    expect(listProviderRecords(db).some((p) => p.id === GW_ID)).toBe(true);
    expect(listModels(db, GW_ID).length).toBeGreaterThan(0);
    expect(keyring.has("openrouter")).toBe(true);

    // Act.
    const reset = await req("POST", "/api/v1/system/reset");
    expect(reset.statusCode).toBe(200);
    const body = reset.json();
    expect(body.ok).toBe(true);
    expect(body.wipedTables).toBeGreaterThanOrEqual(20);
    expect(body.abortedTurns).toBe(0);

    // Assert: user data gone…
    expect(listProviderRecords(db).some((p) => p.id === GW_ID)).toBe(false);
    expect(listModels(db, GW_ID)).toEqual([]);
    const projects = await req("GET", "/api/v1/projects");
    expect(projects.json().projects).toEqual([]);
    const sessions = await req("GET", "/api/v1/sessions");
    expect(sessions.json().sessions).toEqual([]);

    // …factory state back (builtin provider rows + the default agent)…
    expect(listProviderRecords(db).some((p) => p.id === "openrouter")).toBe(true);
    const agents = await req("GET", "/api/v1/agents");
    expect(agents.json().agents.length).toBeGreaterThan(0);

    // …and the in-memory keyring is EMPTY (a test right after reset 409s).
    expect(keyring.has("openrouter")).toBe(false);
    const test = await req("POST", "/api/v1/providers/openrouter/test", {});
    expect(test.statusCode).toBe(409);
  });

  it("keeps the migration ledger — a wiped DB still reports its schema version", async () => {
    const reset = await req("POST", "/api/v1/system/reset");
    expect(reset.statusCode).toBe(200);
    const versions = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    expect(versions.n).toBeGreaterThanOrEqual(32);
  });
});
