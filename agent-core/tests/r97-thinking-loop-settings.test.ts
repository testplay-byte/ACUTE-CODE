/**
 * ROUND-97 (R97-D) tests — the thinking-loop guard's SETTINGS domain: the
 * storage accessors + the GET/PUT /settings/thinking-loop route.
 *
 * The owner's report, verbatim: "Currently the thinking loop is quite bad and
 * it does not allow the model to think as it needs to. I do feel like the
 * thinking loop functionality is a good thing to have but I think we should
 * give the user the option in the settings to turn it on or off. By default
 * it will be turned off so that the model can think as much as it needs to
 * and can handle the things better. Make sure to handle it like that and also
 * give the user the option and flexibility to edit the thinking loop
 * management and handle it better."
 *
 * Coverage:
 *  · The DEFAULTS: enabled FALSE (the owner's explicit directive — the model
 *    thinks freely until the user opts in), stallSeconds 120, bytes 24.
 *  · get/set round-trips: a partial PUT persists only its keys (the
 *    setRetrySettings pattern).
 *  · Validation: out-of-bounds numbers + wrong types 400 with the field
 *    named (the route-level checks); the storage throw is the backstop.
 *  · Clamped reads: a hand-planted out-of-bounds row reads back clamped
 *    (the readNumber contract — a corrupt row never produces an impossible
 *    config).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  THINKING_LOOP_DEFAULTS,
  getThinkingLoopSettings,
  setThinkingLoopSettings,
} from "../src/storage/settings";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r97-thinking-loop";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r97-tl-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

function authed(): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("R97-D: the thinking-loop storage domain", () => {
  it("the DEFAULTS are the owner's contract: OFF + the R95 thresholds", () => {
    // "By default it will be turned off so that the model can think as much
    // as it needs to" — the master switch defaults FALSE, and the thresholds
    // keep the R95-E values for the day the user opts in.
    expect(THINKING_LOOP_DEFAULTS).toEqual({ enabled: false, stallSeconds: 120, reasoningBytesKB: 24 });
    expect(getThinkingLoopSettings(db)).toEqual(THINKING_LOOP_DEFAULTS);
  });

  it("a partial PATCH persists only its keys (the setRetrySettings pattern)", () => {
    const afterEnable = setThinkingLoopSettings(db, { enabled: true });
    expect(afterEnable).toEqual({ enabled: true, stallSeconds: 120, reasoningBytesKB: 24 });
    const afterStall = setThinkingLoopSettings(db, { stallSeconds: 300 });
    expect(afterStall).toEqual({ enabled: true, stallSeconds: 300, reasoningBytesKB: 24 });
    const afterBytes = setThinkingLoopSettings(db, { reasoningBytesKB: 64 });
    expect(afterBytes).toEqual({ enabled: true, stallSeconds: 300, reasoningBytesKB: 64 });
    // A fresh read sees the same truth.
    expect(getThinkingLoopSettings(db)).toEqual({ enabled: true, stallSeconds: 300, reasoningBytesKB: 64 });
  });

  it("out-of-bounds + wrong-type patches THROW (the storage backstop)", () => {
    expect(() => setThinkingLoopSettings(db, { stallSeconds: 10 })).toThrow(/stallSeconds/);
    expect(() => setThinkingLoopSettings(db, { stallSeconds: 601 })).toThrow(/stallSeconds/);
    expect(() => setThinkingLoopSettings(db, { reasoningBytesKB: 4 })).toThrow(/reasoningBytesKB/);
    expect(() => setThinkingLoopSettings(db, { reasoningBytesKB: 257 })).toThrow(/reasoningBytesKB/);
    expect(() => setThinkingLoopSettings(db, { enabled: "yes" as unknown as boolean })).toThrow(/enabled/);
    // Nothing persisted through a rejected patch.
    expect(getThinkingLoopSettings(db)).toEqual(THINKING_LOOP_DEFAULTS);
  });

  it("a hand-planted CORRUPT row reads back CLAMPED (never an impossible config)", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('thinkingLoop.stallSeconds', '5')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('thinkingLoop.reasoningBytesKB', '9999')").run();
    const read = getThinkingLoopSettings(db);
    expect(read.stallSeconds).toBe(30); // clamped to the lower bound
    expect(read.reasoningBytesKB).toBe(256); // clamped to the upper bound
    expect(read.enabled).toBe(false); // untouched
  });
});

describe("R97-D: the GET/PUT /settings/thinking-loop route", () => {
  it("GET returns the defaults on a fresh database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/thinking-loop", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(THINKING_LOOP_DEFAULTS);
  });

  it("PUT accepts a partial patch and returns the updated object", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/thinking-loop",
      ...authed(),
      payload: { enabled: true, stallSeconds: 180 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, stallSeconds: 180, reasoningBytesKB: 24 });
    // The GET reads the same truth (persisted, not just echoed).
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/thinking-loop", ...authed() });
    expect(get.json()).toEqual({ enabled: true, stallSeconds: 180, reasoningBytesKB: 24 });
  });

  it("out-of-bounds numbers 400 with the field named", async () => {
    const stall = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/thinking-loop",
      ...authed(),
      payload: { stallSeconds: 29 },
    });
    expect(stall.statusCode).toBe(400);
    expect(stall.json().error.message).toContain("stallSeconds");
    const bytes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/thinking-loop",
      ...authed(),
      payload: { reasoningBytesKB: 1000 },
    });
    expect(bytes.statusCode).toBe(400);
    expect(bytes.json().error.message).toContain("reasoningBytesKB");
  });

  it("a wrong-typed enabled 400s; a non-object body 400s", async () => {
    const wrongType = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/thinking-loop",
      ...authed(),
      payload: { enabled: "sure" },
    });
    expect(wrongType.statusCode).toBe(400);
    const nonObject = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/thinking-loop",
      ...authed(),
      payload: ["not", "an", "object"],
    });
    expect(nonObject.statusCode).toBe(400);
  });

  it("the route requires auth (the 401 wall holds)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/thinking-loop" });
    expect(res.statusCode).toBe(401);
  });
});
