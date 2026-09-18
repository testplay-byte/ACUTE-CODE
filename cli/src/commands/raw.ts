/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the RAW escape hatch —
 * `acute raw <METHOD> <path> [jsonBody]`, inherited verbatim from the
 * acute.mjs harness: pipe-safe (HTTP status + target → STDERR, the JSON
 * body → STDOUT) so `acute raw GET /sessions | jq` works with no
 * post-processing. Authenticated by the same Bearer wall as everything else.
 */
import { apiFetch } from "../api.js";
import type { CliContext } from "../context.js";

export async function runRawCommand(ctx: CliContext, rest: readonly string[]): Promise<number> {
  const [method, path, ...words] = rest;
  if (method === undefined || path === undefined) {
    ctx.stderr("usage: acute raw <METHOD> <path> [jsonBody]\n");
    return 1;
  }
  const normalized = method.toUpperCase();
  if (!/^(GET|POST|PATCH|PUT|DELETE)$/.test(normalized)) {
    ctx.stderr(`unsupported METHOD '${method}' — GET|POST|PATCH|PUT|DELETE\n`);
    return 1;
  }
  let body: unknown;
  if (words.length > 0) {
    const raw = words.join(" ");
    try {
      body = JSON.parse(raw);
    } catch (err) {
      ctx.stderr(
        `jsonBody is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  const json = await apiFetch<unknown>(ctx.conn, normalized, path, body);
  // Pipe-safe: status + target on stderr, pure JSON on stdout.
  ctx.stderr(`${normalized} ${ctx.conn.baseUrl}/api/v1${path} → 2xx\n`);
  ctx.stdout(`${JSON.stringify(json ?? null, null, 1)}\n`);
  return 0;
}
