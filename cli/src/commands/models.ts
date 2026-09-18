/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the MODELS command group —
 * `acute models [provider]` over GET /models/catalog + /models/configured
 * (the provider arg filters the CONFIGURED rows by providerId), and
 * `acute models test <id>` over POST /models/:id/test (a probe that RAN and
 * got a NO is HTTP 200 {ok:false} — exit 1 with the honest reason).
 */
import { apiFetch } from "../api.js";
import type { CliContext } from "../context.js";
import { trunc } from "../render/tools.js";

/** GET /models/catalog (storage/models.ts constants). */
interface ModelCatalogResponse {
  models: Array<{ modelId: string; displayName: string; contextWindow: number; free?: boolean }>;
  defaultModelId: string;
  subagentDefaultModelId: string;
  recommendedModelIds: string[];
}

/** GET /models/configured rows (storage/models.ts listAllModels). */
interface ConfiguredModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string | null;
}

/** POST /models/:id/test (providers/registry.ts ModelTestResult). */
interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  providerId: string;
  model: string;
  checks: Record<string, boolean>;
  contentPreview?: string;
  usage?: { inputTokens: number; outputTokens: number };
  reason?: string;
}

export async function runModelsCommand(ctx: CliContext, rest: readonly string[]): Promise<number> {
  const [sub, arg] = rest;

  if (sub === "test") {
    if (arg === undefined) {
      ctx.stderr("usage: acute models test <modelId>\n");
      return 1;
    }
    const result = await apiFetch<ModelTestResult>(ctx.conn, "POST", `/models/${arg}/test`, {});
    if (ctx.json) {
      ctx.stdout(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    }
    ctx.stdout(
      `${result.ok ? ctx.kit.green("ok  ") : ctx.kit.red("FAIL")} ${result.model} (${result.providerId}) · ${result.latencyMs}ms\n`,
    );
    ctx.stdout(ctx.kit.dim(`  checks ${JSON.stringify(result.checks)}\n`));
    if (result.usage !== undefined) {
      ctx.stdout(ctx.kit.dim(`  usage ${result.usage.inputTokens} in · ${result.usage.outputTokens} out\n`));
    }
    if (result.contentPreview !== undefined) {
      ctx.stdout(ctx.kit.dim(`  reply ${trunc(result.contentPreview.replace(/\s+/g, " "), 140)}\n`));
    }
    if (result.reason !== undefined) {
      ctx.stdout(ctx.kit.red(`  reason ${trunc(result.reason, 200)}\n`));
    }
    return result.ok ? 0 : 1;
  }

  // `acute models [providerId]` — the FIRST positional is a providerId filter
  // unless it is the `test` subcommand (no separate `list` spelling).
  const providerFilter = sub === "test" || sub === undefined ? undefined : sub;
  const catalog = await apiFetch<ModelCatalogResponse>(ctx.conn, "GET", "/models/catalog");
  const configured = await apiFetch<{ models: ConfiguredModel[] }>(ctx.conn, "GET", "/models/configured");

  if (ctx.json) {
    ctx.stdout(
      `${JSON.stringify({
        catalog: providerFilter === undefined ? catalog : undefined,
        models: providerFilter === undefined ? configured.models : configured.models.filter((m) => m.providerId === providerFilter),
      })}\n`,
    );
    return 0;
  }

  if (providerFilter === undefined) {
    ctx.stderr(
      ctx.kit.dim(
        `catalog: ${catalog.models.length} models · default ${catalog.defaultModelId} · recommended ${catalog.recommendedModelIds.join(", ")}\n`,
      ),
    );
    ctx.stderr(ctx.kit.dim(`configured rows (${configured.models.length}):\n`));
    for (const m of configured.models) {
      ctx.stdout(`  ${trunc(m.id, 34).padEnd(34)} ${m.providerId.padEnd(14)} ${m.modelId}\n`);
    }
    return 0;
  }

  const rows = configured.models.filter((m) => m.providerId === providerFilter);
  if (rows.length === 0) {
    ctx.stderr(`no configured models for provider '${providerFilter}' — see: acute models\n`);
    return 1;
  }
  ctx.stderr(ctx.kit.dim(`${rows.length} configured model(s) for provider ${providerFilter}:\n`));
  for (const m of rows) {
    ctx.stdout(`  ${trunc(m.id, 34).padEnd(34)} ${m.modelId}\n`);
  }
  return 0;
}
