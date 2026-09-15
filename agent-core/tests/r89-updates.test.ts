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
  it("R94-B: proceeds ANONYMOUSLY when no PAT is saved (the repo is public)", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    // R90-B1: no env var (deleted in beforeEach) AND no home file. R94-B:
    // the repo is public, so this is no longer a no-token wall — the check
    // goes out ANONYMOUSLY and succeeds when GitHub answers 200.
    plantPat(home, null);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v0.99.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; latest?: string; current: string };
    expect(body.ok).toBe(true);
    expect(body.latest).toBe("0.99.0");
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

  it("R94-B: the installer asset prefers the API url, falls back to browser_download_url", async () => {
    const home = mkdtempSync(join(tempDir, "home-"));
    useFakeHome(home);
    plantPat(home, "github_pat_test");
    // The real GitHub asset shape: BOTH url forms per asset.
    const asset = {
      name: "ACUTE-CODE_0.99.0_x64-setup.exe",
      url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/77",
      browser_download_url:
        "https://github.com/testplay-byte/ACUTE-CODE/releases/download/v0.99.0/ACUTE-CODE_0.99.0_x64-setup.exe",
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
    mockFetchWith({ tag_name: "v0.99.0", assets: [asset] });
    const res = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body = res.json() as { ok: boolean; asset?: { url: string; size: number; digest: string | null } };
    expect(body.ok).toBe(true);
    expect(body.asset?.url).toBe(asset.url);
    expect(body.asset?.size).toBe(37_000_000);
    expect(body.asset?.digest).toBe(`sha256:${"ab".repeat(32)}`);

    // 2. API url absent/empty → the browser_download_url ships instead.
    mockFetchWith({ tag_name: "v0.99.0", assets: [{ ...asset, url: "" }] });
    const res2 = await app.inject({ method: "GET", url: "/api/v1/system/updates", ...authed() });
    const body2 = res2.json() as { asset?: { url: string } };
    expect(body2.asset?.url).toBe(asset.browser_download_url);

    // 3. BOTH empty → no asset at all (nothing downloadable to offer).
    mockFetchWith({ tag_name: "v0.99.0", assets: [{ ...asset, url: "", browser_download_url: "" }] });
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
            tag_name: "v0.99.0",
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
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ tag_name: "v0.99.0" }), {
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
        new Response(JSON.stringify({ tag_name: "v0.99.0", body: longBody }), {
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
        new Response(JSON.stringify({ tag_name: "v0.99.0", body: "y".repeat(8_000) }), {
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
        // The browser_download_url shape findInstallerAsset hands the UI —
        // the host the pre-R94 allowlist rejected (the owner's exact bug).
        url: "https://github.com/testplay-byte/ACUTE-CODE/releases/download/v9.9.9/ACUTE-CODE_9.9.9_x64-setup.exe",
        digest,
        version: "v9.9.9",
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
    expect(settled!.path!.endsWith("ACUTE-CODE-9.9.9-x64-setup.exe")).toBe(true);
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
    expect(settled!.path!.endsWith("ACUTE-CODE-9.9.9-x64-setup.exe")).toBe(true);
    expect(settled!.version).toBe("9.9.9");

    // The Authorization header carried the PAT (the private-repo asset).
    const [, init] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer github_pat_test");
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
