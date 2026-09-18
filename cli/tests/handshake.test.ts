/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6 M2): the SPAWN HANDSHAKE integration —
 * a REAL `node agent-core/dist/main.js` on a TEMP DB: the ACUTE_READY line
 * parsed (the ephemeral port came from it), the health poll, the R98-K
 * portal file the sidecar writes next to the DB, the Bearer-authenticated
 * /api/v1 call, and the SIGTERM teardown (kill on exit — the R54 orphan
 * discipline). Skipped when agent-core is not built: the CI gate order runs
 * `pnpm test` BEFORE `pnpm build`, so a fresh checkout has no dist/ — the
 * terminal-sessions / node-pty skipIf precedent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ApiError, apiFetch, healthFetch } from "../src/api.js";
import { releaseConnection, type Connection } from "../src/connection.js";
import { spawnSidecar, type SpawnedSidecar } from "../src/spawn.js";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MAIN_JS = join(REPO_ROOT, "agent-core", "dist", "main.js");

/** The spawned sidecar under test (one boot, torn down in afterAll). */
let sidecar: SpawnedSidecar | null = null;
let tmp: string | null = null;

afterAll(async () => {
  if (sidecar !== null) {
    await killSidecar(sidecar);
    sidecar = null;
  }
  if (tmp !== null) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** SIGTERM + grace + SIGKILL — releaseConnection's exact discipline. */
async function killSidecar(spawned: SpawnedSidecar): Promise<void> {
  await releaseConnection({
    baseUrl: `http://127.0.0.1:${spawned.port}`,
    token: spawned.token,
    source: "spawn",
    ownsSidecar: true,
    portalFile: spawned.portalFile,
    port: spawned.port,
    spawned,
  });
}

describe.skipIf(!existsSync(MAIN_JS))(
  "the spawn handshake (CLI-DESIGN §6 M2 — real agent-core/dist/main.js)",
  () => {
    it(
      "spawns, handshakes, serves, and tears down on a TEMP DB",
      async () => {
        tmp = mkdtempSync(join(tmpdir(), "acute-cli-handshake-"));
        const dbPath = join(tmp, "acute.db");

        const notices: string[] = [];
        const spawned = await spawnSidecar({
          repoRoot: REPO_ROOT,
          dbPath,
          env: {}, // no ambient ACUTE_PROVIDER_* — honest no-key sidecar
          home: join(tmp, "home"), // the §5 key ladder finds nothing here
          notice: (line) => notices.push(line),
        });
        sidecar = spawned;

        // The handshake resolved: the port came from the ACUTE_READY line…
        expect(spawned.port).toBeGreaterThan(0);
        expect(Number.isInteger(spawned.port)).toBe(true);
        // …the token is the 256-bit hex the CLI minted (64 hex chars)…
        expect(spawned.token).toMatch(/^[0-9a-f]{64}$/);
        // …and the spawn progress notice fired.
        expect(notices.join("\n")).toContain(`sidecar ready on 127.0.0.1:${spawned.port}`);
        expect(spawned.child.pid).toBeGreaterThan(0);

        // R98-K: the sidecar wrote the portal file NEXT TO THE DB.
        const portalFile = join(tmp, "acute-portal.json");
        expect(spawned.portalFile).toBe(portalFile);
        const portal = JSON.parse(readFileSync(portalFile, "utf8")) as {
          port: number;
          token: string;
          pid: number;
        };
        expect(portal.port).toBe(spawned.port);
        expect(portal.token).toBe(spawned.token);
        expect(portal.pid).toBe(spawned.child.pid);

        // The health poll target answers (loopback shape, no auth).
        const health = await healthFetch(`http://127.0.0.1:${spawned.port}`);
        expect(health).toMatchObject({ status: "ok", app: "acute-code" });
        expect(typeof health?.version).toBe("string");

        // The Bearer wall: an authenticated /api/v1 call through apiFetch.
        const conn: Connection = {
          baseUrl: `http://127.0.0.1:${spawned.port}`,
          token: spawned.token,
          source: "spawn",
          ownsSidecar: true,
          portalFile: spawned.portalFile,
          port: spawned.port,
          spawned,
        };
        const { agents } = await apiFetch<{ agents: Array<{ id: string }> }>(conn, "GET", "/agents");
        expect(Array.isArray(agents)).toBe(true);

        // A WRONG token is rejected by the wall (the honest 401 envelope).
        const rejected = await apiFetch(
          { ...conn, token: "f".repeat(64) },
          "GET",
          "/agents",
        ).catch((err: unknown) => err);
        expect(rejected).toBeInstanceOf(ApiError);
        expect((rejected as ApiError).status).toBe(401);
        expect((rejected as ApiError).describe()).toContain("401");
      },
      60_000,
    );

    it(
      "SIGTERM tears the spawned sidecar down (kill on exit, R54)",
      async () => {
        expect(sidecar).not.toBeNull();
        const spawned = sidecar!;
        const child = spawned.child;
        expect(child.exitCode).toBeNull(); // still alive here
        await killSidecar(spawned);
        // exited during the grace window (SIGTERM → main.ts's handler → 0)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        sidecar = null;
      },
      30_000,
    );

    it("a repoRoot without agent-core/dist fails the honest 'not built' error", async () => {
      const empty = mkdtempSync(join(tmpdir(), "acute-cli-nodist-"));
      try {
        await expect(spawnSidecar({ repoRoot: empty, dbPath: join(empty, "x.db") })).rejects.toThrow(
          /agent-core is not built .*pnpm --filter agent-core run build/,
        );
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  },
);
