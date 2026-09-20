/**
 * ROUND-113 (R113-a) — the APPEARANCE settings surface (GET/PUT
 * /api/v1/settings/appearance, storage/settings.ts's appearance.* rows) —
 * the theme-sync backbone:
 *
 *   1. STORAGE — the appearance.{themeId,mode} rows: default shape
 *      ({themeId: null, mode: "system"}), get/set round-trip, partial
 *      patches leave the other field alone, themeId null clears the
 *      preference row, unknown stored values degrade fail-open.
 *   2. ROUTE — GET serves the default; PUT validates (themeId must be one
 *      of the six shared flavor ids or null; mode must be
 *      system|light|dark — each 400 names its field), persists, and
 *      returns the updated object.
 *   3. BROADCAST — every successful PUT fires
 *      {type:"settings",domain:"appearance",value} on the events bus (the
 *      live propagation the phone + desktop consume); a REJECTED PUT
 *      broadcasts nothing.
 *   4. AUTH — the app-level bearer wall applies (401 without a token).
 *   5. THE FAMILY RULE — a sibling domain PUT (memory) broadcasts too: the
 *      R113 contract is EVERY settings domain PUT fans out, not just the
 *      new one.
 *
 * ROUND-114 (R114-b): the domain grew from two fields to FIVE
 * (chatDensity / chatTextSize / timestampsMode / toolActivity — the
 * chat-density tier). This suite's pins were updated to the full shape by
 * composing over the defaults below (the four-field vocabulary + partial
 * PUT + broadcast pins themselves live in r114-sync-wave.test.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { getEventsBus, type EventsBusFrame } from "../src/lib/events-bus";
import {
  APPEARANCE_DEFAULTS,
  getAppearanceSettings,
  setAppearanceSettings,
} from "../src/storage/settings";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r113appearance";

/** R114-b: the domain's full five-field default — every expectation below
 * composes over it (the R113 pins stay two-field-shaped in intent; the
 * three density fields ride at their defaults unless a test sets them). */
const FULL_DEFAULTS = {
  themeId: null,
  mode: "system",
  chatDensity: "comfortable",
  chatTextSize: "medium",
  timestampsMode: "hover",
  toolActivity: "detailed",
};

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r113appearance-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
});

afterEach(async () => {
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
  method: "GET" | "PUT";
  url: string;
  payload?: Record<string, unknown>;
  token?: string;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method: options.method,
    url: options.url,
    headers: { authorization: `Bearer ${options.token ?? TOKEN}` },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  })) as LightMyRequestResponse;
}

/** Subscribe to the bus for one test; returns the collected frames + the
 * unsubscribe function (the suite's shared singleton must never leak
 * subscribers across tests). */
function collectFrames(): { frames: EventsBusFrame[]; unsubscribe: () => void } {
  const frames: EventsBusFrame[] = [];
  const unsubscribe = getEventsBus().subscribe((frame) => frames.push(frame));
  return { frames, unsubscribe };
}

// ── 1. storage ──────────────────────────────────────────────────────────────

describe("R113-a: appearance settings storage", () => {
  it("reads the default when nothing is stored", () => {
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
    expect(APPEARANCE_DEFAULTS).toEqual(FULL_DEFAULTS);
  });

  it("round-trips both fields and partial patches leave the other alone", () => {
    setAppearanceSettings(db, { themeId: "sunset", mode: "dark" });
    expect(getAppearanceSettings(db)).toEqual({ ...FULL_DEFAULTS, themeId: "sunset", mode: "dark" });
    setAppearanceSettings(db, { mode: "light" });
    expect(getAppearanceSettings(db)).toEqual({ ...FULL_DEFAULTS, themeId: "sunset", mode: "light" });
    setAppearanceSettings(db, { themeId: "bento" });
    expect(getAppearanceSettings(db)).toEqual({ ...FULL_DEFAULTS, themeId: "bento", mode: "light" });
  });

  it("clears the theme preference with null (absent row reads back as null)", () => {
    setAppearanceSettings(db, { themeId: "mono" });
    setAppearanceSettings(db, { themeId: null });
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
  });

  it("rejects values outside the vocabularies (the route's 400 backstop)", () => {
    expect(() => setAppearanceSettings(db, { themeId: "windows-95" as never })).toThrow(/themeId/);
    expect(() => setAppearanceSettings(db, { mode: "sepia" as never })).toThrow(/mode/);
    // Nothing partial was persisted by the rejected patches above.
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
  });

  it("degrades fail-open on corrupt stored rows", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('appearance.themeId', 'retired-flavor')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('appearance.mode', 'sepia')").run();
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
  });
});

// ── 2-4. the route ──────────────────────────────────────────────────────────

describe("R113-a: GET/PUT /settings/appearance", () => {
  it("GET serves the default", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/settings/appearance" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(FULL_DEFAULTS);
  });

  it("PUT persists a valid patch and returns the updated object", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { themeId: "clay", mode: "dark" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...FULL_DEFAULTS, themeId: "clay", mode: "dark" });
    // Persisted — a fresh GET (and the raw storage accessor) agree.
    const get = await authInject({ method: "GET", url: "/api/v1/settings/appearance" });
    expect(get.json()).toEqual({ ...FULL_DEFAULTS, themeId: "clay", mode: "dark" });
    expect(getAppearanceSettings(db)).toEqual({ ...FULL_DEFAULTS, themeId: "clay", mode: "dark" });
  });

  it("PUT null themeId clears the server preference", async () => {
    await authInject({ method: "PUT", url: "/api/v1/settings/appearance", payload: { themeId: "nova" } });
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { themeId: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(FULL_DEFAULTS);
  });

  it("PUT with an unknown themeId 400s naming the field", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { themeId: "windows-95" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION", details: { field: "body.themeId" } },
    });
    // Nothing persisted.
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
  });

  it("PUT with an invalid mode 400s naming the field", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { mode: "sepia" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION", details: { field: "body.mode" } },
    });
    expect(getAppearanceSettings(db)).toEqual(FULL_DEFAULTS);
  });

  it("PUT broadcasts {type:'settings',domain:'appearance'} on the events bus; a 400 broadcasts nothing", async () => {
    const { frames, unsubscribe } = collectFrames();
    try {
      const rejected = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { themeId: "not-a-flavor" },
      });
      expect(rejected.statusCode).toBe(400);
      expect(frames).toHaveLength(0);

      const accepted = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { themeId: "midnight", mode: "light" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(frames).toEqual([
        {
          type: "settings",
          domain: "appearance",
          value: { ...FULL_DEFAULTS, themeId: "midnight", mode: "light" },
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("401s without a bearer token (the app-level wall)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/appearance",
      payload: { themeId: "nova" },
    });
    expect(response.statusCode).toBe(401);
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/appearance" });
    expect(get.statusCode).toBe(401);
  });

  it("a sibling domain PUT broadcasts its own frame (the every-domain rule)", async () => {
    const { frames, unsubscribe } = collectFrames();
    try {
      const response = await authInject({
        method: "PUT",
        url: "/api/v1/settings/memory",
        payload: { enabled: false },
      });
      expect(response.statusCode).toBe(200);
      expect(frames).toEqual([
        { type: "settings", domain: "memory", value: { enabled: false } },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
