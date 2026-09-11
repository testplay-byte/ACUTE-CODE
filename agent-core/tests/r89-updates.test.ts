/**
 * ROUND-89 (R89-A2) — the GET /system/updates route: the server-side update
 * check. The repo is PRIVATE, so the old webview-side anonymous fetch to
 * api.github.com answered HTTP 404 (the owner's verdict); the sidecar now
 * reads the launcher's saved ~/.acute/github.pat and queries GitHub itself.
 *
 * ROUND-90 (R90-B1) — the token-source layers: the launcher saves the PAT in
 * the USER HOME (migrated from the kit-relative .acute/github.pat, which the
 * app could never find) AND hands it to the app it starts via the
 * ACUTE_GITHUB_PAT environment variable. readLauncherGithubPat honors the
 * env var FIRST — the tests below pin both layers.
 *
 * Coverage (global fetch mocked — NEVER a live call in tests):
 *  · no env var + no ~/.acute/github.pat → ok:false reason "no-token" (the
 *    honest error the About tab renders; the button stays useful).
 *  · ACUTE_GITHUB_PAT set → it WINS over a planted home file (the launcher
 *    only ever exports a resolved token; a whitespace-only export falls
 *    through to the file instead of shadowing it).
 *  · a valid answer → ok:true with the tag compared against the engine's
 *    own package.json version (updateAvailable true + false branches).
 *  · GitHub's 404 (a token that cannot see the repo) → ok:false "no-release".
 *  · a network throw → ok:false "network" — never a 500.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, rmSync as rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r89-updates";

/** The mocked home's target — each test points it at its own temp home
 * (the route's `homedir()` reads resolve here at request time). */
const fakeHome = { dir: tmpdir() };
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome.dir };
});

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

/** Point the mocked home at `dir` (the PAT read resolves ~/.acute there). */
function useFakeHome(dir: string): void {
  fakeHome.dir = dir;
}

/** Plant (or remove) the launcher's saved token inside `home`. */
function plantPat(home: string, pat: string | null): void {
  const acute = join(home, ".acute");
  mkdirSync(acute, { recursive: true });
  const target = join(acute, "github.pat");
  if (pat === null) {
    if (existsSync(target)) rm(target, { force: true });
  } else {
    writeFileSync(target, pat, "utf8");
  }
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r89-upd-"));
  // R90-B1: the env layer must start ABSENT so each test controls it — a
  // developer/CI machine that happens to export ACUTE_GITHUB_PAT would
  // otherwise flip every file-based expectation in this suite.
  delete process.env.ACUTE_GITHUB_PAT;
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // R90-B1: the same hermeticity guarantee on the way out (a test that sets
  // the env var must never leak it into the next one).
  delete process.env.ACUTE_GITHUB_PAT;
  fakeHome.dir = tmpdir();
  await app.close();
  db.close();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function authed(): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

describe("GET /system/updates (R89-A2)", () => {
  it("answers ok:false reason no-token when the launcher never saved a PAT", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // R90-B1: no env var (deleted in beforeEach) AND no home file — BOTH
    // token sources missing is what the honest no-token answer means now.
    plantPat(home, null);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason?: string; current: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-token");
    // The current version always rides along (the About tab renders it).
    expect(typeof body.current).toBe("string");
  });

  it("R90-B1: the ACUTE_GITHUB_PAT env var wins over the planted home file", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // The file holds a DIFFERENT token than the env — the Authorization
    // header must carry the env one: the launcher always exports the token
    // it resolved (file, env, or fresh prompt), so the env layer can never
    // be stale relative to the file.
    plantPat(home, "github_pat_from_the_file");
    process.env.ACUTE_GITHUB_PAT = "github_pat_from_the_env";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v0.99.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer github_pat_from_the_env");
    vi.unstubAllGlobals();
  });

  it("R90-B1: a whitespace-only env var falls through to the home file (never shadows it with nothing)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_from_the_file");
    // A blank export must count as absent — otherwise an accidentally-empty
    // ACUTE_GITHUB_PAT would brick the check even with a valid saved file.
    process.env.ACUTE_GITHUB_PAT = "   \n\t ";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v0.99.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer github_pat_from_the_file");
    vi.unstubAllGlobals();
  });

  it("compares the engine's package.json version against the tag (both branches)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v0.99.0", html_url: "https://x/releases/v0.99.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const up = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const upBody = up.json() as { ok: boolean; latest?: string; updateAvailable?: boolean };
    expect(upBody.ok).toBe(true);
    expect(upBody.latest).toBe("0.99.0");
    expect(upBody.updateAvailable).toBe(true);
    // The Authorization header carried the planted PAT (server-side only).
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer github_pat_test");

    // Same tag as the running version → up to date.
    const manifest = await import("../package.json", { with: { type: "json" } });
    const current = (manifest.default as { version: string }).version;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ tag_name: `v${current}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const cur = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const curBody = cur.json() as { ok: boolean; updateAvailable?: boolean };
    expect(curBody.ok).toBe(true);
    expect(curBody.updateAvailable).toBe(false);
    vi.unstubAllGlobals();
  });

  it("maps GitHub's 404 to the honest no-release answer (never a raw 404 wall)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-release");
    vi.unstubAllGlobals();
  });

  it("maps a network throw to ok:false reason network (the route never 500s)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("network");
    expect(body.error).toContain("ENOTFOUND");
    vi.unstubAllGlobals();
  });
});
