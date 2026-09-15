/**
 * ROUND-98 (R98-K, owner: "I want our application to be usable using the
 * terminal tool") — the CLI's PORTAL-DISCOVERY contract, BOTH sides:
 *
 *   1. the SIDECAR side (agent-core/src/server.ts startServer): booting
 *      writes <dbDir>/acute-portal.json — {port, token, pid, startedAt}
 *      (the port/token shape is the whole point: exactly what
 *      ACUTE_BASE_URL/ACUTE_TOKEN would have carried); the TOKEN is never
 *      logged (still exactly ONE ACUTE_READY line, port only); a graceful
 *      close removes the file.
 *   2. the CLI side (scripts/acute-discovery.mjs — the tiny extracted
 *      resolver; importing the 930-line acute.mjs itself would EXECUTE the
 *      CLI's top-level switch, hence the extraction): the candidate order
 *      (the repo's .dev/ over the packaged state dir), the strict
 *      port/token validation, the corrupt-file tolerance, and the derived
 *      baseUrl.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PORTAL_DISCOVERY_FILENAME, startServer } from "../src/server";
import {
  PORTAL_FILENAME,
  portalDiscoveryCandidates,
  portalStateDir,
  readPortalDiscoveryFile,
  resolvePortalDiscovery,
} from "../../scripts/acute-discovery.mjs";

const dir = mkdtempSync(join(tmpdir(), "acute-r98k-"));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── side 1: the sidecar writes (and removes) the discovery file ─────────────

describe("startServer's portal discovery file (R98-K)", () => {
  const TOKEN = "r98k-discovery-token";

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("writes <dbDir>/acute-portal.json with the port/token/pid/startedAt shape, logs NO token, and removes it on close", async () => {
    const dbDir = join(dir, "sidecar");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "acute.db");

    // The ready-line pin: exactly ONE console.log, port-only (the token must
    // never reach stdout — the discovery file is its one CLI-side channel).
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const running = await startServer({ token: TOKEN, dbPath });
    try {
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(`ACUTE_READY ${JSON.stringify({ port: running.port })}`);
      expect(log.mock.calls[0]?.[0] ?? "").not.toContain(TOKEN);

      // The file: <dbDir>/acute-portal.json with the full shape.
      const file = join(dbDir, PORTAL_DISCOVERY_FILENAME);
      expect(running.discoveryFile).toBe(file);
      expect(existsSync(file)).toBe(true);
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(raw.port).toBe(running.port); // the REAL bound port
      expect(raw.token).toBe(TOKEN);
      expect(typeof raw.pid).toBe("number");
      expect(raw.pid).toBe(process.pid);
      expect(typeof raw.startedAt).toBe("string");
      expect(raw.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await running.server.close();
    }

    // Graceful shutdown removes the file (best-effort removal, pinned hard).
    expect(existsSync(join(dbDir, PORTAL_DISCOVERY_FILENAME))).toBe(false);
    // The DB itself is untouched by the contract — only the portal file.
    expect(existsSync(dbPath)).toBe(true);
  });

  it("overwrites a STALE file from a previous boot (last boot wins) instead of failing", async () => {
    const dbDir = join(dir, "stale");
    mkdirSync(dbDir, { recursive: true });
    const stale = join(dbDir, PORTAL_DISCOVERY_FILENAME);
    writeFileSync(stale, JSON.stringify({ port: 1, token: "stale", pid: 1, startedAt: "2020-01-01T00:00:00.000Z" }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    const running = await startServer({ token: TOKEN, dbPath: join(dbDir, "acute.db") });
    try {
      const raw = JSON.parse(readFileSync(stale, "utf8")) as Record<string, unknown>;
      expect(raw.port).toBe(running.port);
      expect(raw.token).toBe(TOKEN);
    } finally {
      await running.server.close();
    }
    expect(existsSync(stale)).toBe(false);
  });
});

// ── side 2: the CLI's pure resolver (scripts/acute-discovery.mjs) ────────────

describe("acute-discovery.mjs resolver (R98-K)", () => {
  /** A scratch "repo root" with a .dev/ discovery file (the dev stack). */
  function repoWithDev(file: string): string {
    const root = mkdtempSync(join(dir, "repo-"));
    mkdirSync(join(root, ".dev"), { recursive: true });
    writeFileSync(join(root, ".dev", PORTAL_FILENAME), file);
    return root;
  }

  it("candidates: the repo's .dev/ FIRST, then the packaged state dir; null stateDir collapses to one candidate", () => {
    const root = "/tmp/some-repo";
    expect(portalDiscoveryCandidates(root, "/state/acute-code")).toEqual([
      join("/tmp/some-repo", ".dev", PORTAL_FILENAME),
      join("/state/acute-code", PORTAL_FILENAME),
    ]);
    expect(portalDiscoveryCandidates(root, null)).toEqual([
      join("/tmp/some-repo", ".dev", PORTAL_FILENAME),
    ]);
    // The default state dir mirrors the Rust shell's state_dir() (the
    // acute-code leaf under the platform's per-user data base).
    expect(portalStateDir()).toMatch(/acute-code$/);
  });

  it("resolves the dev-stack file: full record + derived baseUrl + the file it came from", () => {
    const root = repoWithDev(
      JSON.stringify({ port: 5199, token: "cli-token", pid: 4242, startedAt: "2026-09-15T00:00:00.000Z" }),
    );
    const found = resolvePortalDiscovery(root, "/state/acute-code-that-does-not-exist");
    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      baseUrl: "http://127.0.0.1:5199",
      token: "cli-token",
      port: 5199,
      pid: 4242,
      startedAt: "2026-09-15T00:00:00.000Z",
      file: join(root, ".dev", PORTAL_FILENAME),
    });
  });

  it("priority: the repo .dev/ file WINS over the state-dir file (dev stack over installed app)", () => {
    const root = repoWithDev(JSON.stringify({ port: 5178, token: "dev-token" }));
    const stateDir = mkdtempSync(join(dir, "state-"));
    writeFileSync(
      join(stateDir, PORTAL_FILENAME),
      JSON.stringify({ port: 5300, token: "installed-token" }),
    );
    const found = resolvePortalDiscovery(root, stateDir);
    expect(found).toMatchObject({ port: 5178, token: "dev-token" });
  });

  it("falls back to the STATE-DIR file when the repo has no .dev/ file", () => {
    const root = mkdtempSync(join(dir, "repo-empty-"));
    const stateDir = mkdtempSync(join(dir, "state-"));
    writeFileSync(
      join(stateDir, PORTAL_FILENAME),
      JSON.stringify({ port: 5300, token: "installed-token", pid: 7, startedAt: null }),
    );
    const found = resolvePortalDiscovery(root, stateDir);
    expect(found).toMatchObject({
      baseUrl: "http://127.0.0.1:5300",
      token: "installed-token",
      port: 5300,
      file: join(stateDir, PORTAL_FILENAME),
    });
  });

  it("returns null when NOTHING usable exists (no files anywhere)", () => {
    const root = mkdtempSync(join(dir, "repo-bare-"));
    expect(resolvePortalDiscovery(root, "/state/acute-code-absent")).toBeNull();
  });

  it("tolerates corrupt/invalid files: bad JSON, missing token, non-integer port, out-of-range port, non-object", () => {
    const badFiles = [
      "{not json",
      JSON.stringify({ port: 5199 }), // no token
      JSON.stringify({ token: "t" }), // no port
      JSON.stringify({ port: 0.5, token: "t" }), // non-integer
      JSON.stringify({ port: 0, token: "t" }), // out of range (low)
      JSON.stringify({ port: 65536, token: "t" }), // out of range (high)
      JSON.stringify(["array", "not", "object"]),
      JSON.stringify({ port: "5199", token: "t" }), // string port
      JSON.stringify({ port: 5199, token: "" }), // empty token
    ];
    for (const bad of badFiles) {
      const root = repoWithDev(bad);
      expect(resolvePortalDiscovery(root, "/state/acute-code-absent")).toBeNull();
    }
    // readPortalDiscoveryFile on an absent path is null too.
    expect(readPortalDiscoveryFile(join(dir, "never-exists", PORTAL_FILENAME))).toBeNull();
  });

  it("the pid/startedAt metadata is TOLERANT (null/absent) while port/token stay strict", () => {
    const root = repoWithDev(JSON.stringify({ port: 5178, token: "t" }));
    const found = resolvePortalDiscovery(root, "/state/acute-code-absent");
    expect(found).toMatchObject({ pid: null, startedAt: null, baseUrl: "http://127.0.0.1:5178" });
  });
});
