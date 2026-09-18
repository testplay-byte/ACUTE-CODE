/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the CONFIG command — `acute config
 * get [key]` / `acute config set <key> <value>` over ~/.acute/cli.json
 * (default agent/model/db; no secrets ever — provider keys live in
 * ~/.acute/<id>.key, a DIFFERENT contract). Purely local, no connection.
 */
import { isConfigKey, readCliConfig, writeCliConfig, type ConfigKey } from "../config.js";
import type { UiContext } from "../context.js";

const USAGE = `usage:
  acute config get [agent|model|db]   show the whole store or one key
  acute config set <key> <value>      set agent|model|db (value validated
                                      the same way the flags are)`;

export async function runConfigCommand(ctx: UiContext, rest: readonly string[]): Promise<number> {
  const [sub, key, ...words] = rest;

  if (sub === "get") {
    const store = readCliConfig();
    if (key === undefined) {
      if (ctx.json) {
        ctx.stdout(`${JSON.stringify(store)}\n`);
        return 0;
      }
      ctx.stdout(`~/.acute/cli.json\n`);
      for (const k of ["agent", "model", "db"] as const) {
        ctx.stdout(`  ${k.padEnd(8)} ${store[k] ?? "(unset)"}\n`);
      }
      return 0;
    }
    if (!isConfigKey(key)) {
      ctx.stderr(`unknown config key '${key}' — agent|model|db\n`);
      return 1;
    }
    if (ctx.json) {
      ctx.stdout(`${JSON.stringify({ [key]: store[key] ?? null })}\n`);
      return 0;
    }
    ctx.stdout(`${store[key] ?? "(unset)"}\n`);
    return 0;
  }

  if (sub === "set") {
    if (key === undefined || words.length === 0) {
      ctx.stderr("usage: acute config set <agent|model|db> <value>\n");
      return 1;
    }
    if (!isConfigKey(key)) {
      ctx.stderr(`unknown config key '${key}' — agent|model|db\n`);
      return 1;
    }
    const value = words.join(" ").trim();
    if (value === "") {
      ctx.stderr("config values must be non-empty\n");
      return 1;
    }
    const store = readCliConfig();
    store[key] = value;
    writeCliConfig(store);
    if (ctx.json) {
      ctx.stdout(`${JSON.stringify({ [key as ConfigKey]: value })}\n`);
      return 0;
    }
    ctx.stdout(`set ${key} = ${value}\n`);
    return 0;
  }

  ctx.stderr(`${sub === undefined ? "" : `unknown config subcommand: ${sub}\n`}${USAGE}\n`);
  return 1;
}
