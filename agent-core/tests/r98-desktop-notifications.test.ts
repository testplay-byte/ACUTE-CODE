/**
 * ROUND-98 (R98-J, owner: task complete / failed / permission needed →
 * "it will send me a notification on my PC") — the DESKTOP-NOTIFICATIONS
 * settings domain: storage + route.
 *
 * The r97-browser-settings.test.ts idiom exactly: the DEFAULTS pin, the
 * partial-patch persistence, the non-boolean 400 with the field named,
 * the 401 bearer wall, and the fresh-GET default (ON — the pre-R98
 * behavior shipped notifications enabled).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  DESKTOP_NOTIFICATIONS_DEFAULTS,
  getDesktopNotificationsSettings,
  setDesktopNotificationsSettings,
} from "../src/storage/settings";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r98-desktop-notify";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98-desktop-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

function authed(): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("R98-J: the desktop-notifications settings storage", () => {
  it("the DEFAULT is ON (the pre-R98 behavior — notifications shipped enabled)", () => {
    expect(DESKTOP_NOTIFICATIONS_DEFAULTS).toEqual({ enabled: true });
    expect(getDesktopNotificationsSettings(db)).toEqual({ enabled: true });
  });

  it("a partial patch persists only its key; a fresh read sees the same truth", () => {
    const afterOff = setDesktopNotificationsSettings(db, { enabled: false });
    expect(afterOff).toEqual({ enabled: false });
    expect(getDesktopNotificationsSettings(db)).toEqual({ enabled: false });
    const afterOn = setDesktopNotificationsSettings(db, { enabled: true });
    expect(afterOn).toEqual({ enabled: true });
  });

  it("an empty patch is a no-op read-back (the bridge's initial sync)", () => {
    expect(setDesktopNotificationsSettings(db, {})).toEqual({ enabled: true });
  });

  it("a non-boolean enabled throws (the route's 400 backstop)", () => {
    expect(() => setDesktopNotificationsSettings(db, { enabled: "yes" as never })).toThrow(
      /enabled must be a boolean/,
    );
    expect(getDesktopNotificationsSettings(db)).toEqual({ enabled: true }); // nothing persisted
  });

  it("a corrupt row falls back to the default (readBoolean's defensive read)", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('desktopNotifications.enabled', 'maybe')").run();
    expect(getDesktopNotificationsSettings(db)).toEqual({ enabled: true });
  });
});

describe("R98-J: the GET/PUT /settings/desktop-notifications route", () => {
  it("GET returns the default ON for a fresh database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/desktop-notifications", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it("PUT accepts a partial patch and persists it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/desktop-notifications",
      ...authed(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/desktop-notifications", ...authed() });
    expect(get.json()).toEqual({ enabled: false });
  });

  it("a non-boolean enabled 400s with the field named; the auth wall holds", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/desktop-notifications",
      ...authed(),
      payload: { enabled: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
    expect(bad.json().error.details.field).toBe("body.enabled");

    const unauthed = await app.inject({ method: "GET", url: "/api/v1/settings/desktop-notifications" });
    expect(unauthed.statusCode).toBe(401);
  });
});
