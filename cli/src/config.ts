/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the CLI's own store at
 * `~/.acute/cli.json` — default agent/model/db for the one-shot + REPL
 * (the `acute config get/set` surface). Plain JSON, no secrets (never a
 * key value — those live in ~/.acute/<id>.key, a DIFFERENT contract).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  /** Default agent id for new sessions (null = first registry agent). */
  agent?: string;
  /** Default per-turn model override. */
  model?: string;
  /** Default spawn DB path (--db). */
  db?: string;
}

/** The store's location (~/.acute/cli.json); injectable for tests. */
export function cliConfigPath(home: string = homedir()): string {
  return join(home, ".acute", "cli.json");
}

const KNOWN_KEYS = ["agent", "model", "db"] as const;
export type ConfigKey = (typeof KNOWN_KEYS)[number];

export function isConfigKey(value: string): value is ConfigKey {
  return (KNOWN_KEYS as readonly string[]).includes(value);
}

/** Read the store — corrupt/absent → {} (a bad file never breaks the CLI). */
export function readCliConfig(home: string = homedir()): CliConfig {
  const file = cliConfigPath(home);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const out: CliConfig = {};
    for (const key of KNOWN_KEYS) {
      const value = raw[key];
      if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the store (creates ~/.acute when needed; best-effort, throws the
 * honest fs error so `config set` can report it). */
export function writeCliConfig(config: CliConfig, home: string = homedir()): void {
  const file = cliConfigPath(home);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
