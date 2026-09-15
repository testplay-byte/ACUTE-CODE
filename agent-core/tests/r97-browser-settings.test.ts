/**
 * ROUND-97 (R97-G) — the BROWSER settings domain: storage + route.
 *
 * The owner: "I would also like you to add a dedicated section in the
 * settings for the browser, like a dedicated browser section in the settings,
 * which I can use to edit some settings of the browsers, manage the browser,
 * and handle the browser in a bit more proper and better-managed way."
 *
 * Coverage:
 *  · The DEFAULTS: DuckDuckGo (the pre-R97 hardcoded engine), the
 *    acute://home homepage, zoom 1, the three quick links.
 *  · Partial patches persist only their keys; GET reads the same truth.
 *  · Validation: the four-engine set, the zoom bounds, the quickLinks shape
 *    (1–12, non-blank labels/urls) — all 400 with the field named.
 *  · Corrupt rows read back defended (the readQuickLinks/readNumber clamps).
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
  BROWSER_SETTINGS_DEFAULTS,
  getBrowserSettings,
  setBrowserSettings,
} from "../src/storage/settings";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r97-browser";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r97-browser-"));
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

describe("R97-G: the browser settings storage", () => {
  it("the DEFAULTS are the pre-R97 behavior (DuckDuckGo + the quick-links trio)", () => {
    expect(BROWSER_SETTINGS_DEFAULTS).toEqual({
      searchEngine: "duckduckgo",
      homepage: "acute://home",
      defaultZoom: 1,
      quickLinks: [
        { label: "GitHub", url: "https://github.com" },
        { label: "MDN", url: "https://developer.mozilla.org" },
        { label: "This app (dev)", url: "http://localhost:5173" },
      ],
      // R99-A: links open in the app's OWN browser by default (the owner's
      // native-browser directive — the app ships the WebView2 engine).
      linkOpeningMode: "in-app",
    });
    expect(getBrowserSettings(db)).toEqual(BROWSER_SETTINGS_DEFAULTS);
  });

  it("partial patches persist only their keys", () => {
    const afterEngine = setBrowserSettings(db, { searchEngine: "brave" });
    expect(afterEngine.searchEngine).toBe("brave");
    expect(afterEngine.homepage).toBe("acute://home");
    const afterHome = setBrowserSettings(db, { homepage: "https://example.com" });
    expect(afterHome).toEqual({
      searchEngine: "brave",
      homepage: "https://example.com",
      defaultZoom: 1,
      quickLinks: BROWSER_SETTINGS_DEFAULTS.quickLinks,
      linkOpeningMode: "in-app",
    });
    const afterZoom = setBrowserSettings(db, { defaultZoom: 1.5 });
    expect(afterZoom.defaultZoom).toBe(1.5);
    const afterLinks = setBrowserSettings(db, {
      quickLinks: [
        { label: "Docs", url: "https://docs.example.com" },
        { label: "Local", url: "C:/dev/page.html" },
      ],
    });
    expect(afterLinks.quickLinks).toEqual([
      { label: "Docs", url: "https://docs.example.com" },
      { label: "Local", url: "C:/dev/page.html" },
    ]);
    // R99-A: the link-opening preference rides the same partial-patch
    // contract — only its own key persists, everything else stays.
    const afterMode = setBrowserSettings(db, { linkOpeningMode: "system" });
    expect(afterMode.linkOpeningMode).toBe("system");
    expect(afterMode.searchEngine).toBe("brave");
    expect(afterMode.homepage).toBe("https://example.com");
    // The fresh read sees the same truth.
    expect(getBrowserSettings(db).searchEngine).toBe("brave");
    expect(getBrowserSettings(db).linkOpeningMode).toBe("system");
  });

  it("validation throws on the bad shapes (the route's 400 backstop)", () => {
    expect(() => setBrowserSettings(db, { searchEngine: "yahoo" as never })).toThrow(/searchEngine/);
    expect(() => setBrowserSettings(db, { defaultZoom: 4 })).toThrow(/defaultZoom/);
    expect(() => setBrowserSettings(db, { defaultZoom: 0.1 })).toThrow(/defaultZoom/);
    expect(() => setBrowserSettings(db, { quickLinks: [] })).toThrow(/quickLinks/);
    expect(() => setBrowserSettings(db, { quickLinks: [{ label: "", url: "https://x.com" }] })).toThrow(/quickLinks/);
    expect(() => setBrowserSettings(db, { quickLinks: [{ label: "X", url: "" }] })).toThrow(/quickLinks/);
    // R99-A: the link-opening mode enum — anything but the two sanctioned
    // spellings is refused (never guessed).
    expect(() => setBrowserSettings(db, { linkOpeningMode: "external" as never })).toThrow(/linkOpeningMode/);
    expect(getBrowserSettings(db)).toEqual(BROWSER_SETTINGS_DEFAULTS); // nothing persisted through a rejected patch
  });

  it("a corrupt quickLinks row reads back the DEFAULTS; a corrupt zoom clamps; a corrupt link mode reads the default", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('browser.quickLinks', 'not json')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('browser.defaultZoom', '99')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('browser.linkOpeningMode', 'sideways')").run();
    const read = getBrowserSettings(db);
    expect(read.quickLinks).toEqual(BROWSER_SETTINGS_DEFAULTS.quickLinks);
    expect(read.defaultZoom).toBe(3); // clamped to the upper bound
    expect(read.linkOpeningMode).toBe("in-app"); // off the enum → the default, never a guess
  });
});

describe("R97-G: the GET/PUT /settings/browser route", () => {
  it("GET returns the defaults on a fresh database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/browser", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BROWSER_SETTINGS_DEFAULTS);
  });

  it("PUT accepts a partial patch and persists it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/browser",
      ...authed(),
      payload: { searchEngine: "google", defaultZoom: 1.25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      searchEngine: "google",
      homepage: "acute://home",
      defaultZoom: 1.25,
      quickLinks: BROWSER_SETTINGS_DEFAULTS.quickLinks,
      linkOpeningMode: "in-app",
    });
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/browser", ...authed() });
    expect(get.json().searchEngine).toBe("google");
  });

  it("a bad engine 400s with the field named; the auth wall holds", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/browser",
      ...authed(),
      payload: { searchEngine: "askjeeves" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("searchEngine");
    const unauthed = await app.inject({ method: "GET", url: "/api/v1/settings/browser" });
    expect(unauthed.statusCode).toBe(401);
  });

  it("R99-A: PUT accepts the linkOpeningMode patch; a bad spelling 400s with the field named", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/browser",
      ...authed(),
      payload: { linkOpeningMode: "system" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkOpeningMode).toBe("system");
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/browser", ...authed() });
    expect(get.json().linkOpeningMode).toBe("system");

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/browser",
      ...authed(),
      payload: { linkOpeningMode: "external" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("linkOpeningMode");
  });
});
