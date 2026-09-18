/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the STATUS command — the read-only
 * attach-side introspection: the CLI's own version, the resolution source
 * (env > portal > nothing), every portal-file candidate (port/pid/startedAt
 * — the TOKEN is never printed), and the LIVE /health probe with the
 * sidecar's version. NEVER spawns — `status` is the one command that must be
 * able to report "nothing is running" honestly. Exit 0 when a sidecar is
 * reachable, 1 when not (script-friendly).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healthFetch } from "../api.js";
import { portalCandidates, readPortalFile } from "../connection.js";
import type { UiContext } from "../context.js";

/** The CLI's own version (cli/package.json next to dist|src). */
export function cliVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "?";
  } catch {
    return "?";
  }
}

export async function runStatusCommand(ctx: UiContext): Promise<number> {
  const env = process.env;
  const repoRoot = ctx.repoRoot;
  const version = cliVersion();

  // 1. Explicit env pair (the strongest source — both or neither, verified
  //    before any dialing so the honest half-pair error surfaces here too).
  const hasBase = env.ACUTE_BASE_URL !== undefined && env.ACUTE_BASE_URL !== "";
  const hasToken = env.ACUTE_TOKEN !== undefined && env.ACUTE_TOKEN !== "";
  if (hasBase !== hasToken) {
    ctx.stderr("ACUTE_BASE_URL and ACUTE_TOKEN must be set together\n");
    return 1;
  }
  const baseUrl = hasBase ? env.ACUTE_BASE_URL!.replace(/\/$/, "") : null;

  // 2. The portal candidates (repo .dev/ first, then the app state dir).
  const candidates = portalCandidates(repoRoot, env);

  const report: Record<string, unknown> = { cli: "acute", cliVersion: version };
  const text: string[] = [];
  text.push(`acute-cli ${version}`);

  let probeUrl: string | null = null;
  let source: string;
  if (baseUrl !== null) {
    source = "env";
    probeUrl = baseUrl;
    text.push(`source: ACUTE_BASE_URL ${baseUrl}`);
    report.source = "env";
    report.baseUrl = baseUrl;
  } else {
    source = "portal";
    report.portalFiles = [];
    for (const file of candidates) {
      const found = readPortalFile(file);
      const entry = {
        file,
        present: found !== null,
        ...(found !== null
          ? { port: found.port, pid: found.pid, startedAt: found.startedAt, token: "…(hidden)" }
          : {}),
      };
      (report.portalFiles as Array<Record<string, unknown>>).push(entry);
      if (found === null) {
        text.push(`portal: ${file} — absent`);
        continue;
      }
      // The token is NEVER printed — presence only (length, not value).
      text.push(
        `portal: ${file} — port ${found.port} · pid ${found.pid ?? "?"} · started ${found.startedAt ?? "?"} · token (hidden, ${found.token.length} chars)`,
      );
      if (probeUrl === null) probeUrl = `http://127.0.0.1:${found.port}`;
    }
    if (probeUrl === null) {
      source = "none";
      text.push("source: none (no ACUTE_BASE_URL/ACUTE_TOKEN, no portal file)");
    } else {
      report.source = "portal";
    }
  }

  // 3. The live /health probe (both versions side by side).
  const health = probeUrl !== null ? await healthFetch(probeUrl, 2_000) : null;
  if (health === null) {
    report.sidecar = null;
    if (ctx.json) {
      ctx.stdout(`${JSON.stringify(report)}\n`);
      return 1;
    }
    for (const line of text) ctx.stdout(`${line}\n`);
    ctx.stderr(
      `sidecar: unreachable${probeUrl !== null ? ` (${probeUrl}/health)` : ""} — run a turn (acute -p "…") to spawn one, or start the app\n`,
    );
    return 1;
  }
  report.sidecar = health;
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(report)}\n`);
    return 0;
  }
  for (const line of text) ctx.stdout(`${line}\n`);
  ctx.stdout(
    `sidecar: healthy at ${probeUrl}/health · ${health.app} ${health.version} (source ${source})\n`,
  );
  return 0;
}
