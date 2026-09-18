/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6): the CONNECTION RESOLUTION units — the
 * R98-K order (ACUTE_BASE_URL+ACUTE_TOKEN both-or-neither → portal discovery
 * file, live-verified via /health → spawn decision) with TEMP files, plus the
 * portal-file parser's strict-tolerant rule and the §5 provider-key ladder
 * (env → ~/.acute/<id>.key → none; values never logged).
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionError,
  portalCandidates,
  PORTAL_FILENAME,
  readPortalFile,
  releaseConnection,
  resolveConnection,
  type Connection,
} from "../src/connection.js";
import { appStateDir, providerEnvName, providerKeyFile, resolveProviderKey } from "../src/spawn.js";

const IS_WINDOWS = process.platform === "win32";

/** A fresh temp dir per test (repoRoot / home / portal files). */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `acute-cli-${prefix}-`));
}

/** One live /health server (the "running sidecar") on an ephemeral port. */
async function startHealthServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "acute-code", version: "0.101.0-test" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        setTimeout(() => reject(new Error("health server close timeout")), 2_000).unref();
      }),
  };
}

/** A port that is DEFINITELY dead: bind ephemeral, then close it. */
async function deadPort(): Promise<number> {
  const { port, close } = await startHealthServer();
  await close();
  return port;
}

/** Write a portal discovery file (the sidecar's exact spelling). */
function writePortal(dir: string, fields: Record<string, unknown>): string {
  mkdirSync(join(dir, ".dev"), { recursive: true });
  const file = join(dir, ".dev", PORTAL_FILENAME);
  writeFileSync(file, `${JSON.stringify(fields, null, 2)}\n`);
  return file;
}

/** An attach-mode connection (releaseConnection must be a no-op). */
const ATTACH: Connection = {
  baseUrl: "http://127.0.0.1:1",
  token: "t",
  source: "portal",
  ownsSidecar: false,
  portalFile: "/nowhere",
  port: 1,
  spawned: null,
};

describe("readPortalFile (strict-tolerant: load-bearing fields required, rest optional)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir("portal-parse");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a well-formed file parses (pid + startedAt optional)", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, `${JSON.stringify({ port: 4599, token: "abc", pid: 123, startedAt: "2026-09-18T00:00:00Z" })}\n`);
    expect(readPortalFile(file)).toEqual({
      port: 4599,
      token: "abc",
      pid: 123,
      startedAt: "2026-09-18T00:00:00Z",
    });
  });

  it("missing pid/startedAt degrade to null — the file stays usable", () => {
    const file = join(dir, "bare.json");
    writeFileSync(file, JSON.stringify({ port: 1, token: "x" }));
    expect(readPortalFile(file)).toEqual({ port: 1, token: "x", pid: null, startedAt: null });
  });

  it("absent, corrupt, and non-object files → null (a bad file never breaks the CLI)", () => {
    expect(readPortalFile(join(dir, "absent.json"))).toBeNull();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    expect(readPortalFile(corrupt)).toBeNull();
    const array = join(dir, "array.json");
    writeFileSync(array, "[1,2]");
    expect(readPortalFile(array)).toBeNull();
  });

  it("a bad PORT (non-integer, 0, negative, >65535, non-number) → null", () => {
    for (const port of [1.5, 0, -1, 70_000, "4599", null]) {
      const file = join(dir, `bad-port-${String(port)}.json`);
      writeFileSync(file, JSON.stringify({ port, token: "x" }));
      expect(readPortalFile(file), `port=${String(port)}`).toBeNull();
    }
  });

  it("an empty or non-string TOKEN → null (the token is load-bearing)", () => {
    const empty = join(dir, "empty-token.json");
    writeFileSync(empty, JSON.stringify({ port: 4599, token: "" }));
    expect(readPortalFile(empty)).toBeNull();
    const noToken = join(dir, "no-token.json");
    writeFileSync(noToken, JSON.stringify({ port: 4599 }));
    expect(readPortalFile(noToken)).toBeNull();
  });
});

describe("portalCandidates + appStateDir (the R98-K priority order)", () => {
  it("the repo's .dev/ file comes FIRST, the app state dir second", () => {
    const repoRoot = tempDir("candidates");
    const home = tempDir("candidates-home");
    const candidates = portalCandidates(repoRoot, { XDG_DATA_HOME: join(home, "xdg") }, home);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(join(repoRoot, ".dev", PORTAL_FILENAME));
    expect(candidates[1]).toBe(join(home, "xdg", "acute-code", PORTAL_FILENAME));
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("appStateDir honors the platform's state-dir convention", () => {
    const home = tempDir("statedir");
    if (IS_WINDOWS) {
      expect(appStateDir({ APPDATA: join(home, "appdata") }, home)).toBe(join(home, "appdata", "acute-code"));
      expect(appStateDir({}, home)).toBe(join(home, ".acute")); // no APPDATA → ~/.acute
    } else {
      expect(appStateDir({ XDG_DATA_HOME: join(home, "xdg") }, home)).toBe(join(home, "xdg", "acute-code"));
      expect(appStateDir({}, home)).toBe(join(home, ".local", "share", "acute-code"));
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("resolveConnection (env → portal → spawn)", () => {
  /** Every temp dir a test creates — afterEach removes them ALL (leak-proof
   * even when an assertion fails mid-test). */
  const scratch: string[] = [];
  const scratchDir = (prefix: string): string => {
    const dir = tempDir(prefix);
    scratch.push(dir);
    return dir;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("1. an explicit env pair wins outright — no portal read, no dial", async () => {
    // A fetch stub that FAILS the test if anything dials: env is strongest.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("resolveConnection must not dial in env mode");
      }),
    );
    const repoRoot = scratchDir("env-mode");
    writePortal(repoRoot, { port: 1, token: "stale" }); // would win if env were skipped
    const conn = await resolveConnection({
      repoRoot,
      env: { ACUTE_BASE_URL: "http://127.0.0.1:4321/", ACUTE_TOKEN: "env-token" },
      home: scratchDir("env-mode-home"),
    });
    expect(conn).toMatchObject({
      baseUrl: "http://127.0.0.1:4321", // the trailing slash is stripped
      token: "env-token",
      source: "env",
      ownsSidecar: false,
      portalFile: null,
      port: 4321,
      spawned: null,
    });
  });

  it("a HALF-explicit pair is an honest ConnectionError — both directions", async () => {
    const repoRoot = scratchDir("half");
    for (const env of [{ ACUTE_BASE_URL: "http://x" }, { ACUTE_TOKEN: "t" }]) {
      await expect(
        resolveConnection({ repoRoot, env: env as NodeJS.ProcessEnv, home: scratchDir("half-home") }),
      ).rejects.toBeInstanceOf(ConnectionError);
      await expect(
        resolveConnection({ repoRoot, env: env as NodeJS.ProcessEnv, home: scratchDir("half-home") }),
      ).rejects.toThrow("ACUTE_BASE_URL and ACUTE_TOKEN must be set together");
    }
  });

  it("2. a LIVE portal file attaches (no spawn) — repo .dev/ beats the state dir", async () => {
    const repoRoot = scratchDir("portal-live");
    const home = scratchDir("portal-live-home");
    const { port, close } = await startHealthServer();
    // BOTH candidates exist and are live — the .dev/ one (first) must win.
    const devFile = writePortal(repoRoot, { port, token: "dev-token" });
    const stateDir = appStateDir({}, home); // the platform-honest candidate #2
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, PORTAL_FILENAME), JSON.stringify({ port, token: "state-dir-token" }));
    const notices: string[] = [];
    const conn = await resolveConnection({
      repoRoot,
      env: {},
      home,
      notice: (line) => notices.push(line),
    });
    expect(conn).toMatchObject({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "dev-token",
      source: "portal",
      ownsSidecar: false,
      portalFile: devFile,
      port,
      spawned: null,
    });
    expect(notices.join("\n")).toContain(`attached to the running sidecar on port ${port}`);
    expect(notices.join("\n")).toContain(devFile);
    await close();
  });

  it("a STALE portal file (dead port) falls through to the SPAWN decision", async () => {
    const repoRoot = scratchDir("portal-stale");
    const port = await deadPort();
    writePortal(repoRoot, { port, token: "stale-token" });
    // repoRoot has no agent-core/dist → the spawn attempt fails with the
    // honest "not built" error — PROOF the resolver reached step 3.
    await expect(
      resolveConnection({ repoRoot, env: {}, home: scratchDir("stale-home") }),
    ).rejects.toThrow("agent-core is not built");
  });

  it("a CORRUPT portal file is skipped like an absent one → spawn decision", async () => {
    const repoRoot = scratchDir("portal-corrupt");
    mkdirSync(join(repoRoot, ".dev"), { recursive: true });
    writeFileSync(join(repoRoot, ".dev", PORTAL_FILENAME), "{corrupt");
    await expect(
      resolveConnection({ repoRoot, env: {}, home: scratchDir("corrupt-home") }),
    ).rejects.toThrow("agent-core is not built");
  });

  it("3. no env, no portal files at all → straight to the spawn decision", async () => {
    const repoRoot = scratchDir("spawn-decision");
    await expect(
      resolveConnection({ repoRoot, env: {}, home: scratchDir("spawn-decision-home") }),
    ).rejects.toThrow(/agent-core is not built .*pnpm --filter agent-core run build/);
  });
});

describe("releaseConnection (the R54 orphan discipline)", () => {
  it("attaching NEVER tears anything down (spawned === null → immediate no-op)", async () => {
    await expect(releaseConnection(ATTACH)).resolves.toBeUndefined();
  });
});

describe("the §5 provider-key ladder (values never logged — source only)", () => {
  it("providerEnvName uppercases and underscores (ProviderKeyring.envVarName's rule)", () => {
    expect(providerEnvName("openrouter")).toBe("ACUTE_PROVIDER_OPENROUTER");
    expect(providerEnvName("my-provider")).toBe("ACUTE_PROVIDER_MY_PROVIDER");
  });

  it("providerKeyFile lands at ~/.acute/<id>.key", () => {
    expect(providerKeyFile("openrouter", "/home/t")).toBe(join("/home/t", ".acute", "openrouter.key"));
  });

  it("ACUTE_PROVIDER_<ID> env wins first — no file, no OS probe", () => {
    const home = tempDir("key-env");
    const key = resolveProviderKey("openrouter", { ACUTE_PROVIDER_OPENROUTER: "sk-env" }, home);
    expect(key).toEqual({ source: "env", value: "sk-env" });
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(IS_WINDOWS)("~/.acute/<id>.key is the second rung (win32 skips key files by design)", () => {
    const home = tempDir("key-file");
    mkdirSync(join(home, ".acute"), { recursive: true });
    writeFileSync(join(home, ".acute", "anthropic.key"), "  sk-file  \n"); // trimmed on read
    const key = resolveProviderKey("anthropic", {}, home);
    expect(key).toEqual({ source: "file", value: "sk-file" });
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(IS_WINDOWS)("no env, no file, no OS keyring → the honest 'none'", () => {
    const home = tempDir("key-none");
    const key = resolveProviderKey("nvidia", {}, home);
    expect(key).toEqual({ source: "none", value: "" });
    rmSync(home, { recursive: true, force: true });
  });
});
