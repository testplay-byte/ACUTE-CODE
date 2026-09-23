/**
 * ROUND-89 (R89-A2) — the GET /system/updates route: the server-side update
 * check. The repo was PRIVATE then, so the old webview-side anonymous fetch
 * to api.github.com answered HTTP 404 (the owner's verdict); the sidecar
 * queried GitHub itself with the launcher's saved ~/.acute/github.pat.
 *
 * ROUND-90 (R90-B1) — the token-source layers: the launcher saves the PAT in
 * the USER HOME (migrated from the kit-relative .acute/github.pat, which the
 * app could never find) AND hands it to the app it starts via the
 * ACUTE_GITHUB_PAT environment variable. readLauncherGithubPat honors the
 * env var FIRST — the tests below pin both layers.
 *
 * ROUND-94 (R94-B) — THE REPO IS PUBLIC: the PAT is optional. Both the check
 * and the download proceed ANONYMOUSLY when no token exists (the
 * Authorization header is simply omitted — no 409/no-token wall anymore),
 * and the download allowlist accepts the browser_download_url shape
 * (github.com/testplay-byte/ACUTE-CODE/releases/download/…) alongside the
 * api.github.com asset endpoint — the owner's "Update now" died on exactly
 * that host mismatch ("body.url must be a GitHub release asset of this
 * repository").
 *
 * Coverage (global fetch mocked — NEVER a live call in tests):
 *  · no env var + no ~/.acute/github.pat → the ANONYMOUS check proceeds and
 *    succeeds when GitHub answers 200 (no Authorization header on the wire).
 *  · the anonymous 404 → ok:false "no-release" with the public-repo message.
 *  · ACUTE_GITHUB_PAT set → it WINS over a planted home file (the launcher
 *    only ever exports a resolved token; a whitespace-only export falls
 *    through to the file instead of shadowing it).
 *  · a valid answer → ok:true with the tag compared against the engine's
 *    own package.json version (updateAvailable true + false branches).
 *  · the release's installer asset prefers the API asset `url` and falls
 *    back to browser_download_url (R94-B findInstallerAsset).
 *  · GitHub's 404 (a token that cannot see the repo) → ok:false "no-release".
 *  · a network throw → ok:false "network" — never a 500.
 *  · the download: ANONYMOUS + a browser_download_url-shaped asset URL →
 *    the stream lands ready with NO Authorization header (R94-B).
 *  · the download: the api.github.com asset URL still accepted (R94-B).
 *  · foreign hosts / wrong repo paths / plain http still 400 — never an
 *    open proxy for arbitrary URLs.
 *
 * ROUND-120 (R120-U) — the PAT-rotation resilience (the owner rotated his
 * GitHub PAT; GitHub answers 401 to bad credentials EVEN ON PUBLIC REPOS,
 * so the check died with HTTP 401 until the anonymous retry landed):
 *  · GET /system/updates: a 401/403 on the PAT-bearing leg retries ONCE
 *    ANONYMOUSLY — the anonymous 200 carries the check + tokenWarning; a
 *    both-legs failure answers the honest reason "token-rejected"; a
 *    no-token failure stays reason "github" with the anonymous copy.
 *  · POST /system/updates/download: the SAME one-leg fallback — the
 *    anonymous stream lands ready; both legs failing lands the honest
 *    both-legs error in the single-flight state.
 *  · PUT /system/updates/token: shape gate (github_pat_/ghp_), LIVE repo
 *    validation (200 + full_name), persist to the mocked home's
 *    ~/.acute/github.pat (trimmed + newline-terminated), the stale env-var
 *    clear (the very next check rides the FRESH token), and every error
 *    message secret-shape scrubbed.
 *  · GET /system/updates/token: present (shape-FREE — a garbage file is
 *    present:true, valid:false) + the live validation verdict, never the
 *    value.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, rmSync as rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
// R104: the platform-aware asset pick's pure matrix half — unit-testable on
// any runner (the route reads process.platform/arch at request time; the
// route-level matrix below stubs those per case).
import { updaterAssetSuffixForPlatform } from "../src/routes/system";

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

/** R101 hotfix (the v0.99.0 tag lesson): the mocked latest tag must be
 * STRICTLY NEWER than the engine's own package.json version — the route
 * compares them live, so a hardcoded "future" pin rots exactly on the
 * release it predicted (the R99-C `v0.99.0` pin aged out the moment the
 * engine reached 0.99.0 and flipped updateAvailable to false in CI).
 * Derived synchronously from the manifest: patch+1, forever-green. */
const ENGINE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const NEWER_VERSION: string = (() => {
  const [maj, min, patch] = ENGINE_VERSION.split(".").map((n) => Number.parseInt(n, 10));
  return `${maj}.${min}.${patch + 1}`;
})();

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
  // R123: the APPIMAGE stub gets the same hermeticity (a test that stubbed
  // the install-type-aware Linux pick must never leak its machine).
  delete process.env.APPIMAGE;
  fakeHome.dir = tmpdir();
  // R104: restore the REAL platform/arch (a test that stubbed the
  // platform-aware asset pick must never leak its machine into the next).
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  Object.defineProperty(process, "arch", { value: REAL_ARCH, configurable: true });
  await app.close();
  db.close();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function authed(): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

// ── R104: the platform-stub helper ───────────────────────────────────────
// The sidecar's platform IS the app's platform (it ships inside the app),
// and the route reads process.platform/process.arch AT REQUEST TIME — so a
// test can pin exactly which machine it simulates. The real values are
// captured once and restored in afterEach (the env-var hermeticity rule).
const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
function stubPlatform(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

/** The full six-asset release shape every real release ships (v0.100.0's
 * actual asset list, names + digests synthetic). */
function sixAssetRelease(): Array<Record<string, unknown>> {
  return [
    { name: `ACUTE-CODE_${NEWER_VERSION}_x64-setup.exe`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/101", browser_download_url: `https://github.com/testplay-byte/ACUTE-CODE/releases/download/v${NEWER_VERSION}/ACUTE-CODE_${NEWER_VERSION}_x64-setup.exe`, size: 38_746_943, digest: `sha256:${"01".repeat(32)}` },
    { name: `ACUTE-CODE_${NEWER_VERSION}_amd64.AppImage`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/102", browser_download_url: `https://github.com/testplay-byte/ACUTE-CODE/releases/download/v${NEWER_VERSION}/ACUTE-CODE_${NEWER_VERSION}_amd64.AppImage`, size: 134_990_328, digest: `sha256:${"02".repeat(32)}` },
    { name: `ACUTE-CODE_${NEWER_VERSION}_aarch64.AppImage`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/103", browser_download_url: `https://github.com/testplay-byte/ACUTE-CODE/releases/download/v${NEWER_VERSION}/ACUTE-CODE_${NEWER_VERSION}_aarch64.AppImage`, size: 132_729_352, digest: `sha256:${"03".repeat(32)}` },
    { name: `ACUTE-CODE_${NEWER_VERSION}_amd64.deb`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/104", browser_download_url: "https://github.com/testplay-byte/ACUTE-CODE/releases/download/x/x.deb", size: 67_291_130, digest: `sha256:${"04".repeat(32)}` },
    { name: `ACUTE-CODE_${NEWER_VERSION}_arm64.deb`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/105", browser_download_url: "https://github.com/testplay-byte/ACUTE-CODE/releases/download/x/x.deb", size: 67_240_846, digest: `sha256:${"05".repeat(32)}` },
    { name: `acute-launcher-kit-v${NEWER_VERSION}.zip`, url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/106", browser_download_url: "https://github.com/testplay-byte/ACUTE-CODE/releases/download/x/kit.zip", size: 125_148, digest: `sha256:${"06".repeat(32)}` },
  ];
}

describe("GET /system/updates (R89-A2)", () => {
  it("R94-B: proceeds ANONYMOUSLY when no PAT is saved (the repo is public)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // R90-B1: no env var (deleted in beforeEach) AND no home file. R94-B:
    // the repo is public, so this is no longer a no-token wall — the check
    // goes out ANONYMOUSLY and succeeds when GitHub answers 200.
    plantPat(home, null);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; latest?: string; current: string };
    expect(body.ok).toBe(true);
    expect(body.latest).toBe(NEWER_VERSION);
    // The current version always rides along (the About tab renders it).
    expect(typeof body.current).toBe("string");
    // ANONYMOUS means anonymous: no Authorization header crossed the wire.
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("R94-B: the anonymous 404 answers no-release with the public-repo message", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-release");
    // The honest public-repo framing — no "save a token" dead end.
    expect(body.error).toContain("public");
    vi.unstubAllGlobals();
  });

  it("R90-B1 + R123: the env layer wins over the planted home file — ON THE RETRY LEG (the check itself is anonymous-first)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // The file holds a DIFFERENT token than the env — the readLauncherGithubPat
    // precedence (env wins) is now exercised on the TOKEN RETRY leg: the
    // anonymous check answers 403 (the rate limit), the token leg fires, and
    // the Authorization header must carry the env one: the launcher always
    // exports the token it resolved (file, env, or fresh prompt), so the env
    // layer can never be stale relative to the file.
    plantPat(home, "github_pat_from_the_file");
    process.env.ACUTE_GITHUB_PAT = "github_pat_from_the_env";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; tokenSaved?: boolean };
    expect(body.ok).toBe(true);
    // R123: tokenSaved rides every answer — the About tab's token row keys on it.
    expect(body.tokenSaved).toBe(true);
    // R123: the FIRST leg is anonymous (the public repo's default) — the
    // token only rides the retry.
    const [, first] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    const [, second] = fetchMock.mock.calls[1] as [unknown, { headers: Record<string, string> }];
    expect(first.headers.Authorization).toBeUndefined();
    expect(second.headers.Authorization).toBe("Bearer github_pat_from_the_env");
    vi.unstubAllGlobals();
  });

  it("R90-B1 + R123: a whitespace-only env var falls through to the home file on the retry leg (never shadows it with nothing)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_from_the_file");
    // A blank export must count as absent — otherwise an accidentally-empty
    // ACUTE_GITHUB_PAT would brick the retry leg even with a valid saved
    // file. The anonymous 403 fires the retry; the FILE token must ride it.
    process.env.ACUTE_GITHUB_PAT = "   \n\t ";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    const [, second] = fetchMock.mock.calls[1] as [unknown, { headers: Record<string, string> }];
    expect(second.headers.Authorization).toBe("Bearer github_pat_from_the_file");
    vi.unstubAllGlobals();
  });

  it("compares the engine's package.json version against the tag (both branches)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ tag_name: `v${NEWER_VERSION}`, html_url: `https://x/releases/v${NEWER_VERSION}` }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const up = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const upBody = up.json() as { ok: boolean; latest?: string; updateAvailable?: boolean; tokenSaved?: boolean };
    expect(upBody.ok).toBe(true);
    expect(upBody.latest).toBe(NEWER_VERSION);
    expect(upBody.updateAvailable).toBe(true);
    // R123: the check ran ANONYMOUSLY (the repo is public — a token is never
    // attached to the first leg), and the answer honestly reports that a
    // token IS saved on this machine (the About tab's token row keys on it).
    expect(upBody.tokenSaved).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();

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

  it("R94-B: the installer asset prefers the API url, falls back to browser_download_url", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    // R104: the asset pick is PLATFORM-AWARE — this test pins the WINDOWS
    // machine's pick (the _x64-setup.exe asset); the matrix below covers
    // the other platforms.
    stubPlatform("win32", "x64");
    // The real GitHub asset shape: BOTH url forms per asset.
    const asset = {
      name: `ACUTE-CODE_${NEWER_VERSION}_x64-setup.exe`,
      url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/77",
      browser_download_url:
        `https://github.com/testplay-byte/ACUTE-CODE/releases/download/v${NEWER_VERSION}/ACUTE-CODE_${NEWER_VERSION}_x64-setup.exe`,
      size: 37_000_000,
      digest: `sha256:${"ab".repeat(32)}`,
    };
    const mockFetchWith = (payload: unknown) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    };

    // 1. Both URL forms present → the API `url` wins (the pre-R94 bug handed
    //    the browser_download_url to a gate that only accepted api.github.com).
    mockFetchWith({ tag_name: `v${NEWER_VERSION}`, assets: [asset] });
    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; asset?: { url: string; size: number; digest: string | null } };
    expect(body.ok).toBe(true);
    expect(body.asset?.url).toBe(asset.url);
    expect(body.asset?.size).toBe(37_000_000);
    expect(body.asset?.digest).toBe(`sha256:${"ab".repeat(32)}`);

    // 2. API url absent/empty → the browser_download_url ships instead.
    mockFetchWith({ tag_name: `v${NEWER_VERSION}`, assets: [{ ...asset, url: "" }] });
    const res2 = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body2 = res2.json() as { asset?: { url: string } };
    expect(body2.asset?.url).toBe(asset.browser_download_url);

    // 3. BOTH empty → no asset at all (nothing downloadable to offer).
    mockFetchWith({ tag_name: `v${NEWER_VERSION}`, assets: [{ ...asset, url: "", browser_download_url: "" }] });
    const res3 = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body3 = res3.json() as { asset?: { url: string } };
    expect(body3.asset).toBeUndefined();
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

// ── R99-C: the release NOTES passthrough (GET /system/updates `body`) —
// the About tab's one-click card renders the release body ("What's new").
// The route caps it at 8,000 chars with an honest truncation marker (the
// full notes live on the release page the same response links), and a
// tag-only release ships "" (the card then renders no notes block).
describe("R99-C: the release-notes body passthrough (GET /system/updates)", () => {
  it("passes a normal-length body through VERBATIM", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            tag_name: `v${NEWER_VERSION}`,
            body: "## What's new\n\n- the one-click silent update\n- the startup auto-check",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; body?: string };
    expect(body.ok).toBe(true);
    expect(body.body).toBe("## What's new\n\n- the one-click silent update\n- the startup auto-check");
    vi.unstubAllGlobals();
  });

  it("a tag-only release (no body field) ships \"\" — never undefined", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; body?: string };
    expect(body.ok).toBe(true);
    expect(body.body).toBe("");
    vi.unstubAllGlobals();
  });

  it("a changelog-sized body is capped at 8,000 chars + the honest truncation marker", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const longBody = "x".repeat(9_001);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}`, body: longBody }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; body?: string };
    expect(body.ok).toBe(true);
    // The cap is EXACTLY the first 8,000 chars + the marker — the cut is
    // visible, never silent.
    expect(body.body?.startsWith("x".repeat(8_000))).toBe(true);
    expect(body.body).toContain("[truncated — the full notes live on the release page]");
    expect(body.body?.length).toBeGreaterThan(8_000);
    expect(body.body?.length).toBeLessThan(8_100);
    // And an exactly-8,000 body rides UNMARKED (the cap is inclusive).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}`, body: "y".repeat(8_000) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res2 = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body2 = res2.json() as { body?: string };
    expect(body2.body).toBe("y".repeat(8_000));
    vi.unstubAllGlobals();
  });
});

// ── R91-E: the IN-APP UPDATE DOWNLOAD (POST /system/updates/download +
// GET /system/updates/download/progress). R94-B: the repo is public, so the
// download runs anonymously when no PAT exists (no 409 anymore) and the
// URL gate accepts BOTH asset shapes — api.github.com AND the github.com
// /releases/download/ permalink — while never becoming an open proxy; the
// stream is verified (sha256 + size floor) before "ready" carries the path
// the Rust shell will execute.
describe("R91-E: the in-app update download", () => {
  it("R94-B: downloads ANONYMOUSLY from a browser_download_url-shaped asset (no PAT, no 409)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // No env var (deleted in beforeEach) and no home file — the anonymous
    // path the public repo now allows. Pre-R94 this answered 409 NO_TOKEN.
    plantPat(home, null);

    // A >10MB asset (the installer floor) built in-memory, hashed for the
    // digest the route must verify.
    const chunk = new Uint8Array(1024 * 1024).fill(0x63);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 11; i += 1) parts.push(chunk);
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        // The browser_download_url shape findUpdaterAsset hands the UI —
        // the host the pre-R94 allowlist rejected (the owner's exact bug).
        url: "https://github.com/testplay-byte/ACUTE-CODE/releases/download/v9.9.9/ACUTE-CODE_9.9.9_x64-setup.exe",
        digest,
        version: "v9.9.9",
        // R104: the REAL asset filename (the About tab posts asset.name) —
        // the staged file keeps GitHub's extension so the Rust shell
        // dispatches on what GitHub named.
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    // NOT the old 409 no-token wall, NOT a 400 host rejection — the public
    // repo's permalink shape is accepted and the anonymous stream starts.
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, status: "downloading" });

    // Poll the progress until it settles (ready | error) — max ~5s.
    let settled: { status: string; path: string | null; error: string | null; version: string | null } | null = null;
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
      const body = res.json() as { status: string; path: string | null; error: string | null; version: string | null };
      if (body.status === "ready" || body.status === "error") settled = body;
    }
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe("ready");
    expect(settled!.path).not.toBeNull();
    // R104: the staged name derives from the REAL asset filename (the
    // pre-R104 hardcoded "ACUTE-CODE-<v>-x64-setup.exe" is gone).
    expect(settled!.path!.endsWith("ACUTE-CODE_9.9.9_x64-setup.exe")).toBe(true);
    expect(settled!.version).toBe("9.9.9");

    // ANONYMOUS means anonymous: no Authorization header crossed the wire
    // (the public repo needs none — the PAT only raises the rate limit).
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    // The downloaded installer file is THIS test's litter — remove it (the
    // route keeps it around by design: the shell runs it).
    rmSync(settled!.path!, { force: true });
    vi.unstubAllGlobals();
  });

  it("400s a non-GitHub or non-https asset URL — never an open proxy for the PAT", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    for (const url of [
      "https://evil.example/setup.exe",
      "http://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/1",
      "https://api.github.com/repos/OTHER/repo/releases/assets/1",
      // R94-B: github.com is allowlisted ONLY under THIS repo's
      // /releases/download/ prefix — any other owner/repo or path shape on
      // that host stays rejected.
      "https://github.com/other/repo/releases/download/v1.0.0/x-setup.exe",
      "https://github.com/testplay-byte/OTHER/releases/download/v1.0.0/x-setup.exe",
      "https://github.com/testplay-byte/ACUTE-CODE/releases/expanded_assets/v1",
      "not-a-url",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/system/updates/download",
        payload: { url },
        ...authed(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    }
  });

  it("streams a real asset to disk with live progress, verifies the sha256, and lands ready", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");

    // A >10MB asset (the installer floor) built in-memory: 11 MiB of a
    // repeating pattern, hashed for the digest the route must verify.
    // R94-B: this also pins that the api.github.com asset-URL shape is
    // STILL accepted now that the github.com permalink is too.
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 11; i += 1) parts.push(chunk);
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        digest,
        version: "v9.9.9",
        // R104: the REAL asset filename (the About tab posts asset.name).
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, status: "downloading" });

    // Poll the progress until it settles (ready | error) — max ~5s.
    let settled: { status: string; path: string | null; error: string | null; version: string | null } | null = null;
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
      const body = res.json() as { status: string; path: string | null; error: string | null; version: string | null };
      if (body.status === "ready" || body.status === "error") settled = body;
    }
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe("ready");
    expect(settled!.path).not.toBeNull();
    // R104: the staged name derives from the REAL asset filename.
    expect(settled!.path!.endsWith("ACUTE-CODE_9.9.9_x64-setup.exe")).toBe(true);
    expect(settled!.version).toBe("9.9.9");

    // R123: the download ran ANONYMOUSLY (the public repo's default leg — a
    // saved token never rides the first fetch anymore).
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    // The downloaded installer file is THIS test's litter — remove it (the
    // route keeps it around by design: the shell runs it).
    rmSync(settled!.path!, { force: true });
    vi.unstubAllGlobals();
  });

  it("an MISMATCHED digest lands status error with the honest message (the file is removed)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    const chunk = new Uint8Array(1024 * 1024).fill(0x62);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 11; i += 1) parts.push(chunk);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } }),
      ),
    );

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://objects.githubusercontent.com/some-asset",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        version: "9.9.9",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);

    let settled: { status: string; error: string | null } | null = null;
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
      const body = res.json() as { status: string; error: string | null };
      if (body.status === "ready" || body.status === "error") settled = body;
    }
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe("error");
    expect(settled!.error).toContain("sha256");
    vi.unstubAllGlobals();
  });
});

// ── R104: the platform-aware updater asset + the two-stage hand-shake's
// sidecar half. The v0.100.0 report's Linux root cause: findInstallerAsset
// ALWAYS answered the WINDOWS setup.exe, so a Linux "Update now" downloaded
// a .exe the Rust shell could only reject. The pick is now keyed off the
// sidecar's own platform/arch, the response carries {kind, name} for the
// frontend's honest copy, the staged file keeps the REAL asset filename,
// and DELETE /system/updates/download walks a staged download back.
describe("R104: the platform-aware updater asset", () => {
  it("the pure matrix: win32→setup.exe, linux+APPIMAGE→arch AppImage, linux-packaged→arch deb, darwin→null", () => {
    expect(updaterAssetSuffixForPlatform("win32", "x64")).toEqual({
      suffix: "_x64-setup.exe",
      kind: "windows-setup",
    });
    expect(updaterAssetSuffixForPlatform("win32", "arm64")).toEqual({
      suffix: "_x64-setup.exe",
      kind: "windows-setup",
    });
    // The R101 naming asymmetry: the deb carries dpkg's `arm64`, the
    // AppImage carries the Rust triple's `aarch64` — an AppImage-launched
    // install wants the AppImage, so aarch64 it is.
    expect(updaterAssetSuffixForPlatform("linux", "arm64", "/home/o/ACUTE-CODE.AppImage")).toEqual({
      suffix: "_aarch64.AppImage",
      kind: "linux-appimage",
    });
    // tauri-bundler names BOTH x86_64 Linux bundles `amd64`.
    expect(updaterAssetSuffixForPlatform("linux", "x64", "/tmp/acute.AppImage")).toEqual({
      suffix: "_amd64.AppImage",
      kind: "linux-appimage",
    });
    // R123: the INSTALL-TYPE split — a packaged (non-AppImage) Linux install
    // picks the arch-matched .deb (dpkg's own `arm64` spelling for the
    // 64-bit ARM port), the pkexec dpkg -i leg's asset.
    expect(updaterAssetSuffixForPlatform("linux", "arm64", undefined)).toEqual({
      suffix: "_arm64.deb",
      kind: "linux-deb",
    });
    expect(updaterAssetSuffixForPlatform("linux", "x64", undefined)).toEqual({
      suffix: "_amd64.deb",
      kind: "linux-deb",
    });
    // A blank/relative APPIMAGE counts as ABSENT (the AppImage runtime
    // always exports an absolute path — anything else is a packaged run).
    expect(updaterAssetSuffixForPlatform("linux", "x64", "")).toEqual({
      suffix: "_amd64.deb",
      kind: "linux-deb",
    });
    expect(updaterAssetSuffixForPlatform("linux", "x64", "relative.AppImage")).toEqual({
      suffix: "_amd64.deb",
      kind: "linux-deb",
    });
    // macOS is not shipped — no in-app updater asset at all.
    expect(updaterAssetSuffixForPlatform("darwin", "arm64")).toBeNull();
  });

  it("the route picks THIS machine's asset from a real six-asset release (windows / linux-arm64 / linux-x64 / linux-deb / darwin)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const assets = sixAssetRelease();
    // A FRESH Response per call — a Response body is single-use, and this
    // test drives five checks through the one mock.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}`, assets }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    type Pick = { asset?: { url: string; name: string; kind: string } };
    const pickFor = async (platform: string, arch: string, appimage?: string): Promise<Pick> => {
      stubPlatform(platform, arch);
      if (appimage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = appimage;
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
      return res.json() as Pick;
    };

    // Windows → the NSIS setup.exe, kind windows-setup, the API url form.
    const win = await pickFor("win32", "x64");
    expect(win.asset?.name).toBe(`ACUTE-CODE_${NEWER_VERSION}_x64-setup.exe`);
    expect(win.asset?.kind).toBe("windows-setup");
    expect(win.asset?.url).toBe("https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/101");

    // Linux ARM64 running FROM an AppImage → the aarch64 AppImage (the
    // R104 atomic-replace leg).
    const arm = await pickFor("linux", "arm64", "/home/o/ACUTE-CODE.AppImage");
    expect(arm.asset?.name).toBe(`ACUTE-CODE_${NEWER_VERSION}_aarch64.AppImage`);
    expect(arm.asset?.kind).toBe("linux-appimage");

    // Linux x64 running from an AppImage → the amd64 AppImage.
    const x64 = await pickFor("linux", "x64", "/tmp/acute.AppImage");
    expect(x64.asset?.name).toBe(`ACUTE-CODE_${NEWER_VERSION}_amd64.AppImage`);
    expect(x64.asset?.kind).toBe("linux-appimage");

    // R123: Linux PACKAGED (no APPIMAGE env — the .deb install) → the
    // arch-matched .deb, kind linux-deb (the pkexec dpkg -i leg).
    const deb64 = await pickFor("linux", "x64");
    expect(deb64.asset?.name).toBe(`ACUTE-CODE_${NEWER_VERSION}_amd64.deb`);
    expect(deb64.asset?.kind).toBe("linux-deb");
    const debArm = await pickFor("linux", "arm64");
    expect(debArm.asset?.name).toBe(`ACUTE-CODE_${NEWER_VERSION}_arm64.deb`);
    expect(debArm.asset?.kind).toBe("linux-deb");

    // macOS → no in-app updater asset at all (the Releases page remains).
    const mac = await pickFor("darwin", "arm64");
    expect(mac.asset).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("R104: the staged download — the name derivation + the discard", () => {
  /** The 11MiB + valid-digest happy stream (the shared harness shape). */
  async function happyStream(): Promise<{ digest: string }> {
    const chunk = new Uint8Array(1024 * 1024).fill(0x71);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 11; i += 1) parts.push(chunk);
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
          { status: 200, headers: { "content-length": String(bytes.byteLength) } },
        ),
      ),
    );
    return { digest };
  }

  /** Poll until the single-flight state settles (ready | error). */
  async function settle(): Promise<{ status: string; path: string | null; error: string | null; version: string | null }> {
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
      const body = res.json() as { status: string; path: string | null; error: string | null; version: string | null };
      if (body.status === "ready" || body.status === "error") return body;
    }
    throw new Error("the download never settled");
  }

  it("the posted name is BASENAME-ONLY: a path-bearing name stages in the tmpdir root, never a subdirectory", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const { digest } = await happyStream();

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        digest,
        version: "v9.9.9",
        // A hostile/accidental path-bearing name — the staged file must be
        // the BASENAME in tmpdir (no traversal, no subdirectories).
        name: "../../evil/ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);

    const settled = await settle();
    expect(settled.status).toBe("ready");
    expect(settled.path).not.toBeNull();
    // The staged file sits in tmpdir's ROOT under the basename (the
    // sanitization stripped every separator + the ../ run).
    expect(settled.path!.endsWith("ACUTE-CODE_9.9.9_x64-setup.exe")).toBe(true);
    expect(settled.path!.startsWith(tmpdir())).toBe(true);
    expect(settled.path!.includes("evil")).toBe(false);
    rmSync(settled.path!, { force: true });
    vi.unstubAllGlobals();
  });

  it("an AppImage-named download under 50MB refuses honestly (the extension-aware floor)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    // 11MiB with a VALID digest — the digest check passes; the
    // extension-aware floor (50MB for an AppImage, 10MB for a setup.exe)
    // is what fires: a real AppImage is ~130MB.
    const { digest } = await happyStream();

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        digest,
        version: "v9.9.9",
        name: "ACUTE-CODE_9.9.9_aarch64.AppImage",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);

    const settled = await settle();
    expect(settled.status).toBe("error");
    expect(settled.error).toContain("not a real AppImage");
    vi.unstubAllGlobals();
  });

  it("DELETE discards a STAGED download: the file is unlinked, the state returns to idle", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const { digest } = await happyStream();

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        digest,
        version: "v9.9.9",
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);
    const settled = await settle();
    expect(settled.status).toBe("ready");
    expect(settled.path).not.toBeNull();
    expect(existsSync(settled.path!)).toBe(true);

    // The walk-back: the staged file is deleted and the single-flight
    // state returns to idle (a later download starts clean).
    const del = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/download", ...authed() });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, status: "idle" });
    expect(existsSync(settled.path!)).toBe(false);

    const progress = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
    expect(progress.json()).toMatchObject({ status: "idle", path: null, version: null });
    vi.unstubAllGlobals();
  });

  it("DELETE refuses honestly (409) while a download is IN FLIGHT — then the state is resettable once it settles", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);

    // A stream that emits ONE chunk and then HOLDS OPEN — the route stays
    // "downloading" until the controller is closed below.
    let release: ((close: boolean) => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x72);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(chunk);
                resolve();
                release = (close) => {
                  if (close) controller.close();
                };
              },
            }),
            { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } },
          ),
        ),
      );
    });

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        version: "v9.9.9",
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);
    await opened;

    // IN FLIGHT: the discard is refused honestly — the single-flight state
    // is the live download's, not the caller's, to cancel out from under.
    const mid = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/download", ...authed() });
    expect(mid.statusCode).toBe(409);
    expect(mid.json().error.code).toBe("CONFLICT");

    // Settle the held stream (a truncation error — 1MB of the promised
    // 11MB), then the discard works again (the error state is walkable).
    release!(true);
    const settled = await settle();
    expect(settled.status).toBe("error");
    const del = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/download", ...authed() });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, status: "idle" });
    vi.unstubAllGlobals();
  });

  it("DELETE from idle is the idempotent reset (200, nothing staged)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);

    const del = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/download", ...authed() });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, status: "idle" });
  });
});

// ── ROUND-123 (R123): the ANONYMOUS-FIRST check. The owner's directive:
// "why does it even require a GitHub token? Isn't our GitHub repository
// public and can't it easily fetch the appropriate version it needs
// without the GitHub token?" The check's legs are now INVERTED from the
// R120-U era: the ANONYMOUS fetch is the default (the repo is public — the
// normal check never attaches a token at all), and the token is a pure
// RETRY ACCELERATOR that fires only when the anonymous leg answered 403
// (the rate limit) or 404 (a private-fork shape) AND one is saved. The
// R120-U dead-token 401 on the first leg is unreachable by construction.
// The matrix below pins every honest branch the two legs can land in.
describe("R123: the anonymous-first check (GET /system/updates)", () => {
  it("a DEAD saved token can never hurt the check — the anonymous leg carries it and the answer carries NO warning (the inversion's key promise)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_rotated_dead");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; latest?: string; tokenWarning?: string; tokenSaved?: boolean };
    // The check SUCCEEDED — anonymously, past the dead token, with no
    // warning: a dead token no longer degrades anything (the R120-U
    // tokenWarning-on-success shape is RETIRED with the inversion).
    expect(body.ok).toBe(true);
    expect(body.latest).toBe(NEWER_VERSION);
    expect(body.tokenWarning).toBeUndefined();
    // tokenSaved stays honest (the About tab's token row keys on it — the
    // row's own live probe reports the token's validity).
    expect(body.tokenSaved).toBe(true);
    // ONE call, anonymous (the token leg never fired — the anonymous leg
    // succeeded, so there was nothing to fix).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, first] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(first.headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("anonymous 403 + a saved WORKING token → the token retry carries the check (the rate-limit accelerator)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_working");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; latest?: string; tokenWarning?: string };
    expect(body.ok).toBe(true);
    expect(body.latest).toBe(NEWER_VERSION);
    expect(body.tokenWarning).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, first] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    const [, second] = fetchMock.mock.calls[1] as [unknown, { headers: Record<string, string> }];
    expect(first.headers.Authorization).toBeUndefined();
    expect(second.headers.Authorization).toBe("Bearer github_pat_working");
    vi.unstubAllGlobals();
  });

  it("anonymous 404 + a saved token → the token retry covers the private-fork shape and carries the check", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_working");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; latest?: string };
    expect(body.ok).toBe(true);
    expect(body.latest).toBe(NEWER_VERSION);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("anonymous 403 + the token ALSO rejected → the honest reason token-rejected with the both-legs copy", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_rotated_dead");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
        .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 })),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason?: string; error?: string; tokenWarning?: string };
    expect(body.ok).toBe(false);
    // The DISTINGUISHED reason — the About tab's re-pairing row keys on it.
    expect(body.reason).toBe("token-rejected");
    expect(body.error).toContain("the anonymous check answered HTTP 403");
    expect(body.error).toContain("GitHub rejected the saved token (HTTP 401)");
    expect(body.error).toContain("remove the saved one");
    expect(body.tokenWarning).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("anonymous 404 + the token leg ALSO 404 → the no-release copy names BOTH legs honestly", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_working");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
        .mockResolvedValueOnce(new Response("Not Found", { status: 404 })),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; reason?: string; error?: string; tokenWarning?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-release");
    expect(body.error).toContain("the anonymous check (HTTP 404)");
    expect(body.error).toContain("the saved GitHub token both answered 404");
    expect(body.tokenWarning).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("anonymous 403 + NO token saved → the distinguished rate-limited reason (the ONE case a token helps)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 403 })));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; reason?: string; error?: string; tokenSaved?: boolean };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("rate-limited");
    expect(body.error).toContain("GitHub's anonymous rate limit answered HTTP 403");
    expect(body.error).toContain("raises it");
    expect(body.tokenSaved).toBe(false);
    // NO retry fired (nothing to attach) — one anonymous call, honestly failed.
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("NO token saved + a non-403 anonymous failure stays reason github with the anonymous copy", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 502 })));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; reason?: string; error?: string; tokenWarning?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("github");
    expect(body.error).toContain("HTTP 502 anonymously");
    expect(body.error).toContain("no GitHub token is required");
    expect(body.tokenWarning).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a saved token is NOT tried when the anonymous leg fails with a non-retryable status (the token is an accelerator, not a bypass)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_working");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("github");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a network throw's message is SECRET-SHAPE SCRUBBED (github_pat_… and the R120-U ghp_… belt)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_LEAKEDVALUE");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND api.github.com — token github_pat_LEAKEDVALUE and ghp_" + "alsolEAKEDvalue0123456789 rode the error"),
      ),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; reason?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("network");
    expect(body.error).toContain("ENOTFOUND");
    // Both GitHub token shapes are scrubbed — the ghp_… belt is new this
    // round (secret-shapes.ts), pinned right here where the PAT lives.
    expect(body.error).toContain("github_pat_***");
    expect(body.error).toContain("ghp_***");
    expect(body.error).not.toContain("LEAKEDVALUE");
    expect(body.error).not.toContain("alsolEAKEDvalue");
    vi.unstubAllGlobals();
  });
});

// ── ROUND-123 (R123): the DOWNLOAD's anonymous-first legs — the same
// inversion the check runs. The public repo's assets download anonymously;
// the Authorization header rides ONLY the retry leg (a 403 rate limit on
// the anonymous attempt, with a token saved).
describe("R123: the anonymous-first download (POST /system/updates/download)", () => {
  /** Poll until the single-flight state settles (ready | error). */
  async function settle(): Promise<{ status: string; path: string | null; error: string | null; version: string | null }> {
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/download/progress", ...authed() });
      const body = res.json() as { status: string; path: string | null; error: string | null; version: string | null };
      if (body.status === "ready" || body.status === "error") return body;
    }
    throw new Error("the download never settled");
  }

  it("anonymous 403 + a saved WORKING token → the token retry streams the asset and the download lands ready", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_working");

    // The 11MiB + valid-digest happy stream (the shared harness shape) —
    // served on the SECOND call only (the first is the anonymous 403).
    const chunk = new Uint8Array(1024 * 1024).fill(0x64);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 11; i += 1) parts.push(chunk);
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        digest,
        version: "v9.9.9",
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);

    const settled = await settle();
    expect(settled.status).toBe("ready");
    expect(settled.path).not.toBeNull();
    // The retry leg went out with the token (the anonymous leg was rate-limited).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, first] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    const [, second] = fetchMock.mock.calls[1] as [unknown, { headers: Record<string, string> }];
    expect(first.headers.Authorization).toBeUndefined();
    expect(second.headers.Authorization).toBe("Bearer github_pat_working");
    rmSync(settled.path!, { force: true });
    vi.unstubAllGlobals();
  });

  it("anonymous 403 then the token leg 401 — both legs fail → the single-flight state lands the honest both-legs error", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_rotated_dead");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 403 }))
        .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 })),
    );

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/system/updates/download",
      payload: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        version: "v9.9.9",
        name: "ACUTE-CODE_9.9.9_x64-setup.exe",
      },
      ...authed(),
    });
    expect(start.statusCode).toBe(200);

    const settled = await settle();
    expect(settled.status).toBe("error");
    expect(settled.error).toContain("the anonymous download answered HTTP 403");
    expect(settled.error).toContain("the saved token's download also failed (HTTP 401)");
    expect(settled.error).toContain("remove the saved GitHub token");
    vi.unstubAllGlobals();
  });
});

// ── ROUND-123 (R123): the TOKEN REMOVAL — DELETE /system/updates/token. The
// owner's directive made the token's role explicit: an OPTIONAL accelerator
// for a public repo must be removable in-app (a launcher-era or rotated-dead
// ~/.acute/github.pat otherwise sits on the machine forever with no UI to
// retire it). The removal clears BOTH layers (file + env snapshot) and is
// idempotently honest about whether either held a token.
describe("R123: DELETE /system/updates/token (the removal)", () => {
  it("removes a saved FILE token, drops the env snapshot, and answers removed:true", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_launcher_era");
    process.env.ACUTE_GITHUB_PAT = "github_pat_env_layer";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, removed: true });
    // Both layers are GONE: the file unlinked, the env snapshot dropped.
    expect(existsSync(join(home, ".acute", "github.pat"))).toBe(false);
    expect(process.env.ACUTE_GITHUB_PAT).toBeUndefined();
    // The removal is a LOCAL act — zero GitHub round-trips.
    expect(fetchMock).not.toHaveBeenCalled();
    // The very next check runs ANONYMOUS by construction (tokenSaved flips).
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const check = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = check.json() as { ok: boolean; tokenSaved?: boolean };
    expect(body.ok).toBe(true);
    expect(body.tokenSaved).toBe(false);
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("removal from the NO-token state is the idempotent success (200, removed:false — never a 404)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal("fetch", vi.fn());

    const res = await app.inject({ method: "DELETE", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, removed: false });
    vi.unstubAllGlobals();
  });
});

// ── ROUND-120 (R120-U): the TOKEN RE-PAIRING PATH — the next PAT rotation is
// self-service. PUT /system/updates/token validates the token LIVE against
// the repo (200 AND full_name) before persisting to ~/.acute/github.pat (the
// R90-B1 home location, trimmed + newline-terminated) and clears the stale
// env snapshot so the running sidecar rides the fresh token immediately;
// GET /system/updates/token answers present/valid only — the PAT's value
// never crosses the REST boundary in either direction.
describe("R120-U: PUT /system/updates/token (the re-pairing write)", () => {
  it("400 VALIDATION for every wrong shape — not github_pat_/ghp_, empty, missing, non-string", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Wrong shapes: the missing-pat body, the empty string, whitespace-only,
    // a non-GitHub prefix, and a non-string — every one 400s on body.pat.
    const payloads: Array<Record<string, unknown>> = [
      {},
      { pat: "" },
      { pat: "   " },
      { pat: "not-a-github-token" },
      { pat: 12345 },
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/system/updates/token",
        payload,
        ...authed(),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string; details?: { field?: string } } };
      expect(body.error.code).toBe("VALIDATION");
      expect(body.error.details?.field).toBe("body.pat");
      expect(body.error.message).toContain("github_pat_");
      expect(body.error.message).toContain("ghp_");
    }
    // And the completely bodyless PUT refuses the same way (request.body
    // lands null — the route's own ?? null belt).
    const bodyless = await app.inject({ method: "PUT", url: "/api/v1/system/updates/token", ...authed() });
    expect(bodyless.statusCode).toBe(400);
    expect((bodyless.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    // The refused writes never reached GitHub and never wrote a file.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".acute", "github.pat"))).toBe(false);
  });

  it("401 UNAUTHORIZED when GitHub rejects the token (the rotated/dead case the route exists for)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad credentials", { status: 401 })));

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/system/updates/token",
      payload: { pat: "github_pat_still_dead" },
      ...authed(),
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("GitHub rejected this token (HTTP 401)");
    // Nothing persisted — a rejected token never lands on disk.
    expect(existsSync(join(home, ".acute", "github.pat"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("503 UNAVAILABLE when GitHub answers 200 for the WRONG repository (the full_name gate)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ full_name: "someone/other-repo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/system/updates/token",
      payload: { pat: "github_pat_wrong_repo" },
      ...authed(),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAVAILABLE");
    expect(body.error.message).toContain("wrong repository");
    expect(existsSync(join(home, ".acute", "github.pat"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("503 on an unreachable GitHub, the message SECRET-SHAPE SCRUBBED (the ghp_ belt)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND — token ghp_LEAKEDCLASSICvalue1234567890 rode the error")),
    );

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/system/updates/token",
      payload: { pat: "ghp_someclassicform1234567890" },
      ...authed(),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAVAILABLE");
    expect(body.error.message).toContain("cannot reach GitHub");
    // The classic-token shape is scrubbed — never the value.
    expect(body.error.message).toContain("ghp_***");
    expect(body.error.message).not.toContain("LEAKEDCLASSICvalue");
    expect(existsSync(join(home, ".acute", "github.pat"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("the happy path: validates, persists TRIMMED + newline-terminated, clears the stale env snapshot — the NEXT check rides the FRESH token", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    // The launcher exported the OLD (rotated) token — the env layer wins
    // reads until the re-pair proves the snapshot stale.
    process.env.ACUTE_GITHUB_PAT = "github_pat_stale_env_snapshot";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ full_name: "testplay-byte/ACUTE-CODE" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/system/updates/token",
      // Surrounding whitespace — the route trims before validating/saving.
      payload: { pat: "  github_pat_fresh_round120  \n" },
      ...authed(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, valid: true });
    // The validation leg carried the TRIMMED token's Bearer header.
    const validationFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, validateInit] = validationFetch.mock.calls[0] as [
      unknown,
      { headers: Record<string, string> },
    ];
    expect(validateInit.headers.Authorization).toBe("Bearer github_pat_fresh_round120");
    // The file landed in the R90-B1 home location: trimmed, one trailing
    // newline (the launcher's own file grammar).
    const saved = readFileSync(join(home, ".acute", "github.pat"), "utf8");
    expect(saved).toBe("github_pat_fresh_round120\n");
    // The stale env snapshot is GONE — the running sidecar reads the file.
    expect(process.env.ACUTE_GITHUB_PAT).toBeUndefined();

    // The proof (R123 shape): the very NEXT check runs ANONYMOUS-FIRST — and
    // when its anonymous leg rate-limits, the RETRY rides the FRESH file
    // token (not the stale env one) — the re-pair is effective without a
    // restart. The first call after the PUT (call index 1) is the anonymous
    // check leg; call index 2 is its token retry.
    validationFetch.mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    validationFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: `v${NEWER_VERSION}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const [, anonInit] = validationFetch.mock.calls[1] as [
      unknown,
      { headers: Record<string, string> },
    ];
    expect(anonInit.headers.Authorization).toBeUndefined();
    const [, checkInit] = validationFetch.mock.calls[2] as [
      unknown,
      { headers: Record<string, string> },
    ];
    expect(checkInit.headers.Authorization).toBe("Bearer github_pat_fresh_round120");
    vi.unstubAllGlobals();
  });

  it("the CLASSIC ghp_ spelling validates and persists exactly like the fine-grained one", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ full_name: "testplay-byte/ACUTE-CODE" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/system/updates/token",
      payload: { pat: "ghp_classicformsavesfine1234567890" },
      ...authed(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, valid: true });
    expect(readFileSync(join(home, ".acute", "github.pat"), "utf8")).toBe(
      "ghp_classicformsavesfine1234567890\n",
    );
    vi.unstubAllGlobals();
  });
});

describe("R120-U: GET /system/updates/token (the health probe — never the value)", () => {
  it("no token saved → present:false, valid:null — ZERO GitHub round-trips", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ present: false, valid: null });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a saved token GitHub ACCEPTS → present:true, valid:true (the probe attaches the Bearer header)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_healthy");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ full_name: "testplay-byte/ACUTE-CODE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.json()).toEqual({ present: true, valid: true });
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer github_pat_healthy");
    // The response body never contains the token's value.
    expect(res.body).not.toContain("github_pat_healthy");
    vi.unstubAllGlobals();
  });

  it("a saved token GitHub REJECTS (the rotation aftermath) → present:true, valid:false", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_rotated_dead");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad credentials", { status: 401 })));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.json()).toEqual({ present: true, valid: false });
    vi.unstubAllGlobals();
  });

  it("present is SHAPE-FREE: a garbage-shaped file token is present:true + valid:false (never a masquerading no-token)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "definitely-not-a-token-shape");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad credentials", { status: 401 })));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.json()).toEqual({ present: true, valid: false });
    vi.unstubAllGlobals();
  });

  it("an unreachable GitHub → present:true, valid:null (present but unverifiable — honest, not invalid)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_healthy");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates/token", ...authed() });
    expect(res.json()).toEqual({ present: true, valid: null });
    vi.unstubAllGlobals();
  });
});
