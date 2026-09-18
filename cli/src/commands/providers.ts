/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the PROVIDERS + KEYS command group —
 * `acute providers` and `acute keys status`, both over GET /providers.
 * hasKey/keyCount FLAGS ONLY — a key VALUE never reaches the terminal (the
 * repo's convention: length only, and only when a key is actually loaded).
 */
import { apiFetch } from "../api.js";
import type { CliContext } from "../context.js";
import { trunc } from "../render/tools.js";

/** GET /providers rows (providers/registry.ts ProviderView). */
interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  apiFormat?: string;
  enabled: boolean;
  hasKey: boolean;
  keyCount: number;
}

export async function runProvidersCommand(ctx: CliContext): Promise<number> {
  const { providers } = await apiFetch<{ providers: ProviderRow[] }>(ctx.conn, "GET", "/providers");
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ providers })}\n`);
    return 0;
  }
  for (const p of providers) {
    ctx.stdout(
      `${p.hasKey ? ctx.kit.green("●") : "○"} ${p.id.padEnd(16)} ${trunc(p.name, 18).padEnd(18)} ${
        p.enabled ? "on " : "off"
      } ${p.baseUrl ?? ""}\n`,
    );
  }
  return 0;
}

/**
 * `acute keys status` — the key-presence report per provider. Flags ONLY:
 * hasKey (●/○), the pool size, and the source the SPAWN ladder would use —
 * never a value. Honest "no key" for the rest.
 */
export async function runKeysStatusCommand(ctx: CliContext): Promise<number> {
  const { providers } = await apiFetch<{ providers: ProviderRow[] }>(ctx.conn, "GET", "/providers");
  if (ctx.json) {
    ctx.stdout(
      `${JSON.stringify({
        providers: providers.map((p) => ({ id: p.id, hasKey: p.hasKey, keyCount: p.keyCount })),
      })}\n`,
    );
    return 0;
  }
  ctx.stderr(ctx.kit.dim(`${providers.length} provider row(s) — flags only, values never leave the sidecar\n`));
  for (const p of providers) {
    const key = p.hasKey
      ? ctx.kit.green(`● has key${p.keyCount > 1 ? ` (pool of ${p.keyCount})` : ""}`)
      : ctx.kit.dim("○ no key");
    ctx.stdout(`${p.id.padEnd(16)} ${key}\n`);
  }
  return 0;
}
