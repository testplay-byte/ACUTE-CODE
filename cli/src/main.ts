/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the CLI ENTRY — flag-table parse,
 * LAZY command dispatch (`await import()` per command module), and `--help`
 * generated from the SAME flags table that drives parsing (single source of
 * truth). NO_COLOR + non-TTY auto-disable everything (color.ts); exit codes
 * are 0 (ok) / 1 (error) / 130 (double Ctrl-C).
 *
 * Lifecycle in --mode json: main emits `cli.attach` once the connection
 * resolves (baseUrl/source/port — NEVER the token) and `cli.exit` with the
 * final code; the turn streams emit `cli.session` + the verbatim frames.
 * The config/status commands are OFFLINE (no connection) — they never
 * attach, spawn, or emit lifecycle lines.
 */
import { colorKitFor } from "./color.js";
import { readCliConfig } from "./config.js";
import {
  defaultRepoRoot,
  releaseConnection,
  resolveConnection,
  type Connection,
} from "./connection.js";
import type { CliContext, UiContext } from "./context.js";
import { flagBool, flagString, parseArgv, renderFlagHelp, GLOBAL_FLAGS } from "./flags.js";
import { ApiError, UnreachableError } from "./api.js";

/** The command surface (CLI-DESIGN §2) — drives --help's command table. */
const COMMANDS: readonly { name: string; summary: string }[] = [
  { name: "sessions", summary: "ls|show|events|ctx|rm|rename|resume — session management" },
  { name: "models", summary: "[provider] · test <id> — catalog, configured rows, probes" },
  { name: "providers", summary: "provider rows (hasKey flags, never values)" },
  { name: "keys", summary: "status — per-provider key presence (flags only)" },
  { name: "config", summary: "get|set — ~/.acute/cli.json (default agent/model/db)" },
  { name: "status", summary: "portal file + /health + both versions (never spawns)" },
  { name: "raw", summary: "<METHOD> <path> [json] — the authenticated escape hatch" },
];

/** `--help` — generated from the flags table + command table (no drift). */
export function renderHelp(): string {
  const lines: string[] = [];
  lines.push("acute — the ACUTE-CODE terminal client (attach-or-spawn)");
  lines.push("");
  lines.push("usage:");
  lines.push("  acute                       the REPL (/model /agent /sessions /stop /compact /exit)");
  lines.push('  acute -p "prompt"           one-shot: create a session → stream → exit');
  lines.push("  acute <command> [args]");
  lines.push("");
  lines.push("commands:");
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(10)} ${c.summary}`);
  lines.push("");
  lines.push("connection:");
  lines.push("  ACUTE_BASE_URL + ACUTE_TOKEN (both or neither) → portal discovery");
  lines.push("  (<repo>/.dev/acute-portal.json, then the app state dir) → spawn a");
  lines.push("  sidecar (agent-core/dist/main.js, ephemeral port, SIGTERM on exit).");
  lines.push("");
  lines.push("flags:");
  lines.push(...renderFlagHelp(GLOBAL_FLAGS));
  lines.push("");
  lines.push("exit codes: 0 ok · 1 error · 130 double Ctrl-C");
  return `${lines.join("\n")}\n`;
}

interface RunOptions {
  /** stdout/stderr writers (tests inject); default process streams. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const parsed = parseArgv(argv);

  // --help always wins (even over unknown flags) — the flags table IS the help.
  if (flagBool(parsed.flags, "help")) {
    stdout(renderHelp());
    return 0;
  }

  if (parsed.unknown.length > 0) {
    stderr(`unknown flag(s): ${parsed.unknown.join(", ")} — see: acute --help\n`);
    return 1;
  }

  const mode = flagString(parsed.flags, "mode");
  if (mode !== undefined && mode !== "text" && mode !== "json") {
    stderr(`--mode must be text or json (got '${mode}')\n`);
    return 1;
  }

  const json = mode === "json";
  const quiet = flagBool(parsed.flags, "quiet");
  const autoApprove = flagBool(parsed.flags, "auto-approve");
  const noColor = flagBool(parsed.flags, "no-color");
  const kit = colorKitFor(process.stdout.isTTY === true && !noColor, process.env);
  const config = readCliConfig();
  const repoRoot = defaultRepoRoot();
  const [command, ...rest] = parsed.positionals;

  const ui: UiContext = {
    stdout,
    stderr,
    kit,
    plain: !kit.enabled,
    quiet,
    json,
    autoApprove,
    config,
    flags: parsed.flags,
    repoRoot,
  };

  // ── the OFFLINE commands (no connection — config is local, status probes) ──
  const offlineError = (err: unknown): number => {
    stderr(`${kit.red(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  };
  if (command === "config") {
    const { runConfigCommand } = await import("./commands/config.js");
    try {
      return await runConfigCommand(ui, rest);
    } catch (err) {
      return offlineError(err);
    }
  }
  if (command === "status") {
    const { runStatusCommand } = await import("./commands/status.js");
    try {
      return await runStatusCommand(ui);
    } catch (err) {
      return offlineError(err);
    }
  }

  // ── everything else attaches or spawns (CLI-DESIGN §1) ──
  const dbPath = flagString(parsed.flags, "db") ?? config.db;
  let conn: Connection;
  try {
    conn = await resolveConnection({
      repoRoot,
      ...(dbPath !== undefined ? { dbPath } : {}),
      notice: (line) => stderr(kit.dim(`${line}\n`)),
    });
  } catch (err) {
    stderr(`${kit.red(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }
  if (dbPath !== undefined && conn.source !== "spawn") {
    stderr(kit.dim("(--db applies to spawn mode only — attaching to a running sidecar)\n"));
  }

  const ctx: CliContext = { ...ui, conn };
  if (ctx.json) {
    const attach: Record<string, unknown> = {
      type: "cli.attach",
      baseUrl: conn.baseUrl,
      source: conn.source,
      port: conn.port,
      ownsSidecar: conn.ownsSidecar,
      ...(conn.portalFile !== null ? { portalFile: conn.portalFile } : {}),
    };
    ctx.stdout(`${JSON.stringify(attach)}\n`);
  }

  let code: number;
  try {
    if (command === undefined) {
      if (flagString(parsed.flags, "print") !== undefined) {
        const { runOneShot } = await import("./commands/oneshot.js");
        code = await runOneShot(ctx);
      } else {
        const { runRepl } = await import("./commands/repl.js");
        // The REPL owns its whole json lifecycle (cli.session … cli.exit).
        return await runRepl(ctx);
      }
    } else {
      switch (command) {
        case "sessions": {
          const { runSessionsCommand } = await import("./commands/sessions.js");
          code = await runSessionsCommand(ctx, rest);
          break;
        }
        case "models": {
          const { runModelsCommand } = await import("./commands/models.js");
          code = await runModelsCommand(ctx, rest);
          break;
        }
        case "providers": {
          const { runProvidersCommand } = await import("./commands/providers.js");
          code = await runProvidersCommand(ctx);
          break;
        }
        case "keys": {
          const { runKeysStatusCommand } = await import("./commands/providers.js");
          if (rest[0] !== undefined && rest[0] !== "status") {
            stderr("usage: acute keys status\n");
            code = 1;
            break;
          }
          code = await runKeysStatusCommand(ctx);
          break;
        }
        case "raw": {
          const { runRawCommand } = await import("./commands/raw.js");
          code = await runRawCommand(ctx, rest);
          break;
        }
        default:
          stderr(`unknown command '${command}' — see: acute --help\n`);
          code = 1;
      }
    }
  } catch (err) {
    code = 1;
    if (err instanceof ApiError) stderr(`${kit.red(err.describe())}\n`);
    else if (err instanceof UnreachableError) stderr(`${kit.red(err.message)}\n`);
    else stderr(`${kit.red(err instanceof Error ? err.message : String(err))}\n`);
  } finally {
    await releaseConnection(conn);
  }
  if (ctx.json) ctx.stdout(`${JSON.stringify({ type: "cli.exit", code })}\n`);
  return code;
}
