/**
 * Usage-summary repository (SPEC §F7 dashboard): SQL aggregation over the
 * append-only `usage_events` log grouped by calendar day, zero-filled in JS
 * for days without traffic so the chart gets a dense ascending series.
 */
import type Database from "better-sqlite3";
// ROUND-83 (R83): lookupPricing for the unpriced-model honesty (costKnown);
// models.ts imports only db.js — no cycle.
import { lookupPricing } from "./models.js";

export type SqliteDatabase = Database.Database;

/** One day bucket as served by GET /api/v1/usage/summary. */
export interface UsageDayBucket {
  /** UTC calendar date, "YYYY-MM-DD" — matches SQLite date(ts) on ISO strings. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: UsageTotals;
  generatedAt: string;
}

interface UsageAggregateRow {
  date: string;
  input_tokens: number | null;
  output_tokens: number | null;
  requests: number;
  cost_usd: number | null;
}

const MS_PER_DAY = 86_400_000;

/** UTC day key `daysBack` days before today (UTC arithmetic; DST-immune). */
function utcDayKey(daysBack: number): string {
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtcMidnight - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Sums of REAL columns pick up binary-float noise; money fields get trimmed. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Per-day usage for the last `options.days` UTC calendar days ending today,
 * ordered ascending and zero-filled. Days are cut on UTC boundaries because
 * that is exactly what SQLite's date(ts) buckets the stored ISO-8601 ts by.
 */
export function getUsageSummary(db: SqliteDatabase, options: { days: number }): UsageSummary {
  const firstDay = utcDayKey(options.days - 1);
  const rows = db
    .prepare(
      `SELECT date(ts) AS date,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              COUNT(*) AS requests,
              SUM(cost_usd) AS cost_usd
       FROM usage_events
       WHERE date(ts) >= ? AND date(ts) <= ?
       GROUP BY date(ts)`,
    )
    .all(firstDay, utcDayKey(0)) as UsageAggregateRow[];

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days: UsageDayBucket[] = [];
  for (let back = options.days - 1; back >= 0; back -= 1) {
    const date = utcDayKey(back);
    const row = byDate.get(date);
    days.push({
      date,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      requests: row?.requests ?? 0,
      costUsd: roundUsd(row?.cost_usd ?? 0),
    });
  }

  const totals = days.reduce<UsageTotals>(
    (sum, day) => ({
      inputTokens: sum.inputTokens + day.inputTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      requests: sum.requests + day.requests,
      costUsd: roundUsd(sum.costUsd + day.costUsd),
    }),
    { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 },
  );

  return { days, totals, generatedAt: new Date().toISOString() };
}

/* ── ROUND-52 (R52-b): detailed usage analytics (the in-app /usage screen) ──
 *
 * Ported from scripts/export-usage.mjs — the PUBLIC usage.json snapshot behind
 * the DASHBOARD site's Usage page (the owner-approved layout this screen
 * mirrors) — with exactly two deliberate deltas:
 *
 *   1. PRIVATE shape: this feeds GET /usage/detailed over the bearer-token
 *      loopback API only, so ids, titles and roles pass through RAW. The
 *      export script hashes ids + redacts titles because its JSON is
 *      published; never port that redaction here.
 *   2. `days`: the export is a whole-history snapshot; this adds the windowed
 *      zero-filled day series from getUsageSummary (the activity chart's
 *      range selector). Totals/tools/models/projects stay whole-history —
 *      the drill-down must keep listing every project, exactly like the
 *      public page.
 */

/** Token triplet shared by every detailed-usage aggregate. */
export interface DetailedUsageTokens {
  input: number;
  output: number;
  cached: number;
}

/** One tool's call volume + failure count (from session_events tool.use). */
export interface DetailedUsageToolCall {
  tool: string;
  count: number;
  failures: number;
}

/** Per-model aggregate (usage_events grouped by session × model, re-summed). */
export interface DetailedUsageModel {
  model: string;
  calls: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  /** ROUND-83 (R83): the real SDK-call count behind the aggregate (the
   * "requests" field counts TURNS/rows — one row per turn since R24; a
   * 5-iteration turn recorded 1 "request" before). */
  providerCalls: number;
  /** ROUND-83 (R83): false when EVERY (provider, model) pricing row that
   * served this model has BOTH sides unknown — the screens render
   * "$0.00 (unpriced)" instead of a silent free lunch (the audit's
   * §2.11). */
  costKnown: boolean;
}

/**
 * ROUND-64 (R64-e, owner: "I want the ability to track each individual API
 * key's stats, like the total usage of that API key, total tokens used on
 * that API key"): one provider key-pool slot's whole-history usage rollup.
 * keySlot 0 = the provider's primary key; N ≥ 2 = the ACUTE_PROVIDER_<ID>_SLOT<N>
 * pool slot the orchestrator assigns sub-agent children (ADR-0022). Rows
 * only exist for slots with recorded spend — the UI joins this with
 * GET /providers/:id/keys (masked poolInfo) to also show configured-but-
 * unused keys, and flags usage on slots the keyring no longer holds
 * ("removed key") as honestly removed.
 */
export interface DetailedUsageKey {
  providerId: string;
  /** 0 = primary key; N ≥ 2 = pool slot N. */
  keySlot: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** ISO ts of the slot's latest recorded call (MAX(ts)); null never happens
   * — the GROUP BY only produces rows from existing usage_events. */
  lastUsedAt: string;
}

/** A chat session (or a sub-agent child) row in the projects drill-down. */
export interface DetailedUsageSession {
  id: string;
  title: string;
  status: string;
  /** Dominant model (highest input+output tokens across its usage rows). */
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  requests: number;
  /** ROUND-83 (R83): the real SDK-call count ("requests" above = turns). */
  providerCalls: number;
  toolCalls: DetailedUsageToolCall[];
  toolCallCount: number;
  /** How many sub-agent children this session delegated (parent rows). */
  subagentCount: number;
  /** True when the row is a delegate_task child (parent_session_id set). */
  isSubagent: boolean;
  /** The delegating parent session's id (null for main sessions). */
  parentId: string | null;
  /** The delegated role (planner/researcher/coder/…), null on main sessions. */
  role: string | null;
}

export interface DetailedUsageProject {
  id: string;
  name: string;
  color: string;
  /** True for the synthetic "Unassigned sessions" bucket (no project row). */
  synthetic: boolean;
  /** Main (non-sub-agent) session count — what the section header shows. */
  sessionCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  totals: {
    sessions: number;
    subagents: number;
    toolCalls: number;
    requests: number;
    costUsd: number;
    tokens: DetailedUsageTokens;
  };
  toolCalls: DetailedUsageToolCall[];
  /** Sub-agent-only rollup nested inside the project totals. */
  subagents: {
    count: number;
    toolCalls: number;
    requests: number;
    tokens: DetailedUsageTokens;
    costUsd: number;
  };
  models: DetailedUsageModel[];
  /** Main + sub-agent children, newest-first (the UI nests children by parentId). */
  sessions: DetailedUsageSession[];
}

export interface DetailedUsageTotals {
  projects: number;
  sessions: number;
  subagentSessions: number;
  toolCalls: number;
  requests: number;
  /** ROUND-83 (R83): the real SDK-call count ("requests" above = turns). */
  providerCalls: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
}

export interface DetailedUsage {
  /** Windowed, zero-filled, ascending (getUsageSummary's series). */
  days: UsageDayBucket[];
  /** Whole-history rollups (mirrors the export script's totals). */
  totals: DetailedUsageTotals;
  tools: DetailedUsageToolCall[];
  models: DetailedUsageModel[];
  /** ROUND-64 (R64-e): per-key (provider × pool slot) rollups, cost-desc. */
  keys: DetailedUsageKey[];
  projects: DetailedUsageProject[];
  generatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  project_id: string | null;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  parent_session_id: string | null;
  sub_role: string | null;
}

interface SessionUsageRow {
  session_id: string;
  requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_usd: number | null;
  provider_calls: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

interface SessionModelRow {
  session_id: string;
  model: string;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_usd: number | null;
  provider_calls: number | null;
}

interface SessionToolRow {
  session_id: string;
  tool: string | null;
  count: number;
  failures: number;
}

/** usage_events GROUP BY provider, key_slot row (migration 0024). */
interface KeyUsageRow {
  provider: string;
  key_slot: number;
  requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  last_used: string | null;
}

/** ISO string → epoch ms; null/invalid → 0 (the export script's ts() helper). */
function toMillis(iso: string | null | undefined): number {
  return iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : 0;
}

function emptyUsageTokens(): DetailedUsageTokens {
  return { input: 0, output: 0, cached: 0 };
}

/**
 * Token source accepting BOTH shapes this module sums: snake_case SQL rows
 * (input_tokens/…) and camelCase session aggregates (tokens.input/…) — the
 * export script's addTokens() trick, one accumulator for both.
 */
interface TokenSource {
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
}

function addUsageTokens(acc: DetailedUsageTokens, row: TokenSource): DetailedUsageTokens {
  acc.input += row.input ?? row.input_tokens ?? 0;
  acc.output += row.output ?? row.output_tokens ?? 0;
  acc.cached += row.cached ?? row.cached_input_tokens ?? 0;
  return acc;
}

/** Count-desc, tool-name tiebreak — the leaderboard order everywhere. */
function sortedToolCalls(map: Map<string, { count: number; failures: number }>): DetailedUsageToolCall[] {
  return [...map.entries()]
    .map(([tool, m]) => ({ tool, count: m.count, failures: m.failures }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/** Project colors are a UI palette, never data; non-hex rows fall back to the brand accent. */
function safeProjectColor(raw: string | null | undefined): string {
  return /^#[0-9A-Fa-f]{6}$/.test(String(raw ?? "")) ? String(raw).toUpperCase() : "#FF6B2C";
}

function sortedModels(
  map: Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number; providerCalls: number }>,
  unpriced: ReadonlySet<string>,
): DetailedUsageModel[] {
  return [...map.entries()]
    .map(([model, m]) => ({
      model,
      calls: m.calls,
      tokens: m.tokens,
      costUsd: m.costUsd,
      providerCalls: m.providerCalls,
      costKnown: !unpriced.has(model),
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

/**
 * ROUND-83 (R83): model names whose EVERY (provider, model) pricing row that
 * served them has both sides unknown (the audit's §2.11 — a paid model added
 * without pricing rows records cost_usd = 0 and the screens showed a silent
 * free lunch). Model-name granularity: the same model id served by a priced
 * provider elsewhere counts as priced (pricing is per provider×model row;
 * the aggregate is model-keyed — the honest hedge is documented here).
 */
function unpricedModelNames(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT provider, model FROM usage_events")
    .all() as { provider: string; model: string }[];
  const unpriced = new Set<string>();
  for (const row of rows) {
    const pricing = lookupPricing(db, row.provider, row.model);
    if (pricing.inputPricePerMtok === null && pricing.outputPricePerMtok === null) {
      unpriced.add(row.model);
    }
  }
  return unpriced;
}

/**
 * ROUND-64 (R64-e): per-key rollups — GROUP BY provider, key_slot over the
 * whole history (migration 0024's idx_usage_events_provider_slot serves
 * exactly this scan). Cost-desc like the owner's "which key is spending"
 * question; provider id then slot number break ties so the section is
 * deterministic. Token sums COALESCE — pre-0024 rows (and any hand-seeded
 * row) can hold NULLs per the schema's nullable SUM shape.
 */
function keyUsageRows(db: SqliteDatabase): DetailedUsageKey[] {
  const rows = db
    .prepare(
      "SELECT provider, key_slot, COUNT(*) requests, SUM(input_tokens) input_tokens," +
        " SUM(output_tokens) output_tokens, SUM(cost_usd) cost_usd, MAX(ts) last_used" +
        " FROM usage_events GROUP BY provider, key_slot",
    )
    .all() as KeyUsageRow[];
  return rows
    .map((row) => ({
      providerId: row.provider,
      keySlot: row.key_slot,
      requests: row.requests,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      costUsd: roundUsd(row.cost_usd ?? 0),
      lastUsedAt: row.last_used ?? new Date(0).toISOString(),
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        a.providerId.localeCompare(b.providerId) ||
        a.keySlot - b.keySlot,
    );
}

/** The session's dominant model — highest input+output tokens (export's topByValue). */
function dominantModel(
  models: Map<string, SessionModelRow>,
): SessionModelRow | null {
  let best: SessionModelRow | null = null;
  let bestTokens = -1;
  for (const row of models.values()) {
    const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = row;
    }
  }
  return best;
}

/** Mutable working view of a session row (internal ms fields stripped before serving). */
interface SessionView extends DetailedUsageSession {
  rawId: string;
  startMs: number;
  endMs: number;
}

/**
 * Whole-history usage analytics for the in-app /usage screen: per-tool and
 * per-model leaderboards plus a projects → sessions drill-down with sub-agent
 * children nested by parentId (same aggregation the public usage.json export
 * runs, minus the redaction — see the section header). `options.days` only
 * scopes the zero-filled `days` activity series (getUsageSummary).
 */
export function getDetailedUsage(db: SqliteDatabase, options: { days: number }): DetailedUsage {
  const dayBuckets = getUsageSummary(db, { days: options.days }).days;

  const projectRows = db
    .prepare("SELECT id, name, color, created_at FROM projects ORDER BY created_at, id")
    .all() as ProjectRow[];
  const sessionRows = db
    .prepare(
      "SELECT id, project_id, status, title, created_at, updated_at, parent_session_id, sub_role" +
        " FROM sessions ORDER BY created_at, id",
    )
    .all() as SessionRow[];

  const usageBySession = new Map<string, SessionUsageRow>();
  for (const row of db
    .prepare(
      "SELECT session_id, COUNT(*) requests, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens," +
        " SUM(COALESCE(cached_input_tokens, 0)) cached_input_tokens, SUM(cost_usd) cost_usd," +
        " SUM(COALESCE(provider_calls, 1)) provider_calls," +
        " MIN(ts) first_ts, MAX(ts) last_ts FROM usage_events GROUP BY session_id",
    )
    .all() as SessionUsageRow[]) {
    usageBySession.set(row.session_id, row);
  }

  const modelsBySession = new Map<string, Map<string, SessionModelRow>>();
  for (const row of db
    .prepare(
      "SELECT session_id, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens," +
        " SUM(COALESCE(cached_input_tokens, 0)) cached_input_tokens, SUM(cost_usd) cost_usd," +
        " SUM(COALESCE(provider_calls, 1)) provider_calls" +
        " FROM usage_events GROUP BY session_id, model",
    )
    .all() as SessionModelRow[]) {
    if (!modelsBySession.has(row.session_id)) modelsBySession.set(row.session_id, new Map());
    modelsBySession.get(row.session_id)!.set(row.model, row);
  }

  const toolsBySession = new Map<string, Map<string, { count: number; failures: number }>>();
  for (const row of db
    .prepare(
      "SELECT session_id, json_extract(payload, '$.toolName') tool, COUNT(*) count," +
        " SUM(CASE WHEN json_extract(payload, '$.ok') = 0 THEN 1 ELSE 0 END) failures" +
        " FROM session_events WHERE type = 'tool.use' GROUP BY session_id, tool",
    )
    .all() as SessionToolRow[]) {
    if (!row.tool) continue; // malformed payload — never guess
    if (!toolsBySession.has(row.session_id)) toolsBySession.set(row.session_id, new Map());
    toolsBySession.get(row.session_id)!.set(row.tool, { count: row.count, failures: row.failures });
  }

  const lastEventMs = new Map<string, number>();
  for (const row of db
    .prepare("SELECT session_id, MAX(ts) m FROM session_events GROUP BY session_id")
    .all() as { session_id: string; m: string | null }[]) {
    lastEventMs.set(row.session_id, toMillis(row.m));
  }

  /* session records (raw ids/titles — PRIVATE endpoint, no export redaction) */
  const viewsByRawId = new Map<string, SessionView>();
  for (const row of sessionRows) {
    const usage = usageBySession.get(row.id);
    const models = modelsBySession.get(row.id) ?? new Map<string, SessionModelRow>();
    const tools = toolsBySession.get(row.id) ?? new Map<string, { count: number; failures: number }>();
    const startMs = toMillis(row.created_at);
    const endMs = Math.max(
      toMillis(row.updated_at),
      usage ? toMillis(usage.last_ts) : 0,
      lastEventMs.get(row.id) ?? 0,
    );
    const toolCallCount = [...tools.values()].reduce((n, t) => n + t.count, 0);
    viewsByRawId.set(row.id, {
      id: row.id,
      title: row.title ?? "(untitled)",
      status: row.status ?? "queued",
      model: dominantModel(models)?.model ?? null,
      startedAt: startMs > 0 ? row.created_at : null,
      endedAt: endMs > 0 ? new Date(endMs).toISOString() : null,
      durationMs: startMs > 0 && endMs >= startMs ? endMs - startMs : 0,
      tokens: usage ? addUsageTokens(emptyUsageTokens(), usage) : emptyUsageTokens(),
      costUsd: roundUsd(usage?.cost_usd ?? 0),
      requests: usage?.requests ?? 0,
      // ROUND-83 (R83): the real SDK-call count (COALESCE(1) keeps
      // pre-0031 rows exactly true — one row = one call since R24).
      providerCalls: usage?.provider_calls ?? 0,
      toolCalls: sortedToolCalls(tools),
      toolCallCount,
      subagentCount: 0,
      isSubagent: row.parent_session_id !== null,
      parentId: row.parent_session_id,
      role: row.sub_role ?? null,
      rawId: row.id,
      startMs,
      endMs,
    });
  }

  /* parent → children count (subagentCount on the parent row) */
  for (const row of sessionRows) {
    if (!row.parent_session_id) continue;
    const parent = viewsByRawId.get(row.parent_session_id);
    if (parent) parent.subagentCount += 1;
  }

  /* project groups — children ride their OWN project_id (export semantics) */
  const projectIdBySession = new Map(sessionRows.map((row) => [row.id, row.project_id]));
  const views = sessionRows.map((row) => viewsByRawId.get(row.id)!);
  const byProject = new Map<string, SessionView[]>();
  const unassigned: SessionView[] = [];
  const knownProjectIds = new Set(projectRows.map((p) => p.id));
  for (const view of views) {
    const projectId = projectIdBySession.get(view.rawId) ?? null;
    if (projectId && knownProjectIds.has(projectId)) {
      const group = byProject.get(projectId) ?? [];
      group.push(view);
      byProject.set(projectId, group);
    } else {
      unassigned.push(view);
    }
  }

  function buildProject(
    name: string,
    id: string,
    sessions: SessionView[],
    synthetic: boolean,
    color: string,
  ): DetailedUsageProject {
    const mains = sessions.filter((s) => !s.isSubagent);
    const subs = sessions.filter((s) => s.isSubagent);
    const totals = {
      sessions: mains.length,
      subagents: subs.length,
      toolCalls: 0,
      requests: 0,
      costUsd: 0,
      tokens: emptyUsageTokens(),
    };
    const toolMap = new Map<string, { count: number; failures: number }>();
    const modelMap = new Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number; providerCalls: number }>();
    let first = Infinity;
    let last = -Infinity;
    for (const session of sessions) {
      totals.toolCalls += session.toolCallCount;
      totals.requests += session.requests;
      totals.costUsd = roundUsd(totals.costUsd + session.costUsd);
      addUsageTokens(totals.tokens, session.tokens);
      for (const t of session.toolCalls) {
        const m = toolMap.get(t.tool) ?? { count: 0, failures: 0 };
        m.count += t.count;
        m.failures += t.failures;
        toolMap.set(t.tool, m);
      }
      for (const model of modelsBySession.get(session.rawId)?.values() ?? []) {
        const acc =
          modelMap.get(model.model) ?? { calls: 0, tokens: emptyUsageTokens(), costUsd: 0, providerCalls: 0 };
        acc.calls += model.calls;
        addUsageTokens(acc.tokens, model);
        acc.costUsd = roundUsd(acc.costUsd + (model.cost_usd ?? 0));
        acc.providerCalls += model.provider_calls ?? 0;
        modelMap.set(model.model, acc);
      }
      if (session.startMs > 0) first = Math.min(first, session.startMs);
      if (session.endMs > 0) last = Math.max(last, session.endMs);
    }
    const subTotals = {
      count: subs.length,
      toolCalls: subs.reduce((n, s) => n + s.toolCallCount, 0),
      requests: subs.reduce((n, s) => n + s.requests, 0),
      tokens: subs.reduce((acc, s) => addUsageTokens(acc, s.tokens), emptyUsageTokens()),
      costUsd: roundUsd(subs.reduce((n, s) => n + s.costUsd, 0)),
    };
    return {
      id,
      name: name || "Project",
      color: safeProjectColor(color),
      synthetic,
      sessionCount: mains.length,
      firstActivity: Number.isFinite(first) ? new Date(first).toISOString() : null,
      lastActivity: last > -Infinity ? new Date(last).toISOString() : null,
      totals,
      toolCalls: sortedToolCalls(toolMap),
      subagents: subTotals,
      models: sortedModels(modelMap, unpriced),
      // Newest-first so the app's capped drill-down shows the recent work
      // (the public export sorts ascending; the screen caps at 20 visible).
      sessions: sessions
        .map(({ rawId: _rawId, startMs: _startMs, endMs: _endMs, ...pub }) => pub)
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    };
  }

  // ROUND-83 (R83): the unpriced-model set both model leaderboards consult
  // (costKnown per row — computed ONCE, before the project groups and the
  // global rollup both read it).
  const unpriced = unpricedModelNames(db);

  const projects: DetailedUsageProject[] = projectRows.map((p) =>
    buildProject(p.name, p.id, byProject.get(p.id) ?? [], false, p.color),
  );
  if (unassigned.length > 0) {
    projects.push(
      buildProject("Unassigned sessions", "unassigned", unassigned, true, "#6B6660"),
    );
  }
  // Most-recently-active first — the owner's drill-down is a "what happened
  // lately" list, not a creation-order archive.
  projects.sort(
    (a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
  );

  /* whole-history global rollups (export's totals/tools/models) */
  const allViews = [...viewsByRawId.values()];
  const totals: DetailedUsageTotals = {
    projects: projectRows.length,
    sessions: allViews.filter((s) => !s.isSubagent).length,
    subagentSessions: allViews.filter((s) => s.isSubagent).length,
    toolCalls: allViews.reduce((n, s) => n + s.toolCallCount, 0),
    requests: allViews.reduce((n, s) => n + s.requests, 0),
    providerCalls: allViews.reduce((n, s) => n + s.providerCalls, 0),
    tokens: allViews.reduce((acc, s) => addUsageTokens(acc, s.tokens), emptyUsageTokens()),
    costUsd: roundUsd(allViews.reduce((n, s) => n + s.costUsd, 0)),
  };

  const globalTools = new Map<string, { count: number; failures: number }>();
  for (const session of allViews) {
    for (const t of session.toolCalls) {
      const m = globalTools.get(t.tool) ?? { count: 0, failures: 0 };
      m.count += t.count;
      m.failures += t.failures;
      globalTools.set(t.tool, m);
    }
  }
  const globalModels = new Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number; providerCalls: number }>();
  for (const view of allViews) {
    for (const model of modelsBySession.get(view.rawId)?.values() ?? []) {
      const acc =
        globalModels.get(model.model) ?? { calls: 0, tokens: emptyUsageTokens(), costUsd: 0, providerCalls: 0 };
      acc.calls += model.calls;
      addUsageTokens(acc.tokens, model);
      acc.costUsd = roundUsd(acc.costUsd + (model.cost_usd ?? 0));
      acc.providerCalls += model.provider_calls ?? 0;
      globalModels.set(model.model, acc);
    }
  }

  return {
    days: dayBuckets,
    totals,
    tools: sortedToolCalls(globalTools),
    models: sortedModels(globalModels, unpriced),
    // ROUND-64 (R64-e): the per-key (provider × slot) rollup for the
    // /usage screen's "API keys" section.
    keys: keyUsageRows(db),
    projects,
    generatedAt: new Date().toISOString(),
  };
}

/* ── ROUND-98 (R98-I2, owner: "Data & statistics … total tokens, peak
 * tokens, the 12-month token-activity heatmap, time-range graphs
 * color-coded by model name — the same name across providers IS one
 * model — the model-usage donut, total cost, agent-health, and
 * clear-all-data"): the windowed stats aggregation behind
 * GET /usage/stats + DELETE /usage/data. Everything here scopes to a
 * CALENDAR-MONTH window ending today (months=12 ⇒ the series runs from
 * one calendar year ago to today, zero-filled); the model grouping keys
 * the `model` column ONLY — "z-ai/glm-5.2" served by openrouter and by a
 * custom gateway is ONE model (the owner's rule), the providers list per
 * name comes from a second DISTINCT scan. ─────────────────────────────── */

/**
 * UTC date key `months` calendar months before today, CLAMPED to the
 * target month's last day (Mar 31 − 1 month ⇒ Feb 28/29, never a
 * nonexistent Feb 31). Calendar-month window like getUsageSummary's
 * utcDayKey is a day window — DST-immune by staying on Date.UTC.
 */
function utcMonthsAgoKey(months: number): string {
  const now = new Date();
  const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  // Last day of the target month: day 0 of the NEXT month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export interface UsageStatsTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** ROUND-83 semantics: SUM(cost_usd) over the window, roundUsd-trimmed. */
  costUsd: number;
  /** Turns — COUNT(*) of usage rows (one row per turn since R24). */
  requests: number;
  /** ROUND-83 semantics: the REAL SDK-call count (SUM(provider_calls)). */
  providerCalls: number;
}

export interface UsageStatsPeak {
  /** The highest input+output UTC day in the window, earliest on ties;
   * null when the window has no traffic at all. */
  date: string | null;
  /** That day's input+output token total (0 when there is no peak). */
  tokens: number;
}

export interface UsageStatsDayBucket {
  /** UTC calendar date, "YYYY-MM-DD" — matches SQLite date(ts). */
  date: string;
  /** Tokens (input+output) per MODEL NAME this day — grouped by the model
   * column ONLY (the owner's same-name-across-providers rule); empty for
   * zero-filled days with no traffic. */
  byModel: Record<string, number>;
}

export interface UsageStatsModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  /** ROUND-83 semantics: the real SDK-call count (SUM(provider_calls)). */
  calls: number;
  /** Turns — COUNT(*) of usage rows. */
  requests: number;
  /** The provider ids that served this model name in the window (a second
   * DISTINCT scan; sorted name-asc so the chip row is deterministic). */
  providers: string[];
}

export interface UsageStatsHealthIssue {
  /** The turn-error class (errorClass, with the payload's code as the
   * honest fallback) or the failing tool's name — a REAL payload field,
   * never a guessed label. */
  name: string;
  /** How many times it occurred in the window. */
  count: number;
}

export interface UsageStatsHealth {
  /** Top-10 turn.error classes by count (errorClass, falling back to the
   * payload's code; rows with NEITHER are skipped, never guessed). */
  turnErrors: UsageStatsHealthIssue[];
  /** Top-10 failing tool names by count (tool.use rows with ok=0; a null
   * toolName is skipped). */
  toolFailures: UsageStatsHealthIssue[];
}

export interface UsageStats {
  /** The window actually used (clamped 1–24; the route validates first). */
  months: number;
  totals: UsageStatsTotals;
  peak: UsageStatsPeak;
  /** Zero-filled ascending day series over the calendar-month window. */
  series: UsageStatsDayBucket[];
  /** Models sorted tokens-desc, ties name-asc. */
  models: UsageStatsModel[];
  health: UsageStatsHealth;
  generatedAt: string;
}

interface StatsTotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  requests: number;
  cost_usd: number | null;
  provider_calls: number | null;
}

interface StatsDayModelRow {
  date: string;
  model: string;
  tokens: number;
}

interface StatsPeakRow {
  date: string;
  tokens: number;
}

interface StatsModelRow {
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  requests: number;
  cost_usd: number | null;
  calls: number | null;
}

interface StatsHealthRow {
  name: string | null;
  count: number;
}

/**
 * Windowed usage statistics for the Data & Statistics surface (GET
 * /usage/stats). Calendar-month window ending today: `months` clamps to
 * 1–24 (the route already 400s out-of-range values; the clamp is the
 * storage backstop). Every aggregate below reads the SAME window: totals,
 * peak day, the zero-filled per-day × per-model series, the model
 * leaderboard (grouped by the model column only — same name across
 * providers is ONE model), and the agent-health counts from
 * session_events.
 */
export function getUsageStats(db: SqliteDatabase, options: { months?: number } = {}): UsageStats {
  const months = Math.min(24, Math.max(1, Math.round(options.months ?? 12)));
  const firstDay = utcMonthsAgoKey(months);
  const lastDay = utcDayKey(0);
  const windowClause = "WHERE date(ts) >= ? AND date(ts) <= ?";

  const totalsRow = db
    .prepare(
      `SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              COUNT(*) AS requests, SUM(cost_usd) AS cost_usd,
              SUM(COALESCE(provider_calls, 1)) AS provider_calls
       FROM usage_events ${windowClause}`,
    )
    .get(firstDay, lastDay) as StatsTotalsRow;
  const totals: UsageStatsTotals = {
    inputTokens: totalsRow.input_tokens ?? 0,
    outputTokens: totalsRow.output_tokens ?? 0,
    totalTokens: (totalsRow.input_tokens ?? 0) + (totalsRow.output_tokens ?? 0),
    costUsd: roundUsd(totalsRow.cost_usd ?? 0),
    requests: totalsRow.requests ?? 0,
    providerCalls: totalsRow.provider_calls ?? 0,
  };

  /* Peak day — highest input+output total, earliest date on ties. */
  const peakRow = db
    .prepare(
      `SELECT date(ts) AS date, SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens
       FROM usage_events ${windowClause}
       GROUP BY date(ts) ORDER BY tokens DESC, date ASC LIMIT 1`,
    )
    .get(firstDay, lastDay) as StatsPeakRow | undefined;
  const peak: UsageStatsPeak =
    peakRow === undefined
      ? { date: null, tokens: 0 } // no traffic in the window at all
      : { date: peakRow.date, tokens: peakRow.tokens };

  /* Zero-filled ascending series, grouped by date × model name. */
  const dayModelRows = db
    .prepare(
      `SELECT date(ts) AS date, model,
              SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens
       FROM usage_events ${windowClause}
       GROUP BY date(ts), model`,
    )
    .all(firstDay, lastDay) as StatsDayModelRow[];
  const byDate = new Map<string, Record<string, number>>();
  for (const row of dayModelRows) {
    const day = byDate.get(row.date) ?? {};
    day[row.model] = row.tokens;
    byDate.set(row.date, day);
  }
  const series: UsageStatsDayBucket[] = [];
  const firstMs = Date.parse(`${firstDay}T00:00:00Z`);
  const lastMs = Date.parse(`${lastDay}T00:00:00Z`);
  const dayCount = Math.round((lastMs - firstMs) / MS_PER_DAY) + 1;
  for (let i = 0; i < dayCount; i += 1) {
    const date = new Date(firstMs + i * MS_PER_DAY).toISOString().slice(0, 10);
    series.push({ date, byModel: byDate.get(date) ?? {} });
  }

  /* Model leaderboard — grouped by the model column ONLY (the owner's
   * same-name rule); providers[] from a second DISTINCT scan. */
  const modelRows = db
    .prepare(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              COUNT(*) AS requests, SUM(cost_usd) AS cost_usd,
              SUM(COALESCE(provider_calls, 1)) AS calls
       FROM usage_events ${windowClause}
       GROUP BY model`,
    )
    .all(firstDay, lastDay) as StatsModelRow[];
  const providersByModel = new Map<string, string[]>();
  for (const row of db
    .prepare(
      `SELECT DISTINCT model, provider FROM usage_events ${windowClause}`,
    )
    .all(firstDay, lastDay) as { model: string; provider: string }[]) {
    providersByModel.set(row.model, [...(providersByModel.get(row.model) ?? []), row.provider]);
  }
  const models: UsageStatsModel[] = modelRows
    .map((row) => ({
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      tokens: (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
      costUsd: roundUsd(row.cost_usd ?? 0),
      calls: row.calls ?? 0,
      requests: row.requests,
      providers: (providersByModel.get(row.model) ?? []).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  /* Agent health — session_events over the SAME window. turn.error rows
   * group by errorClass with the payload's code as the honest fallback
   * (COALESCE — both are REAL payload fields; rows carrying NEITHER are
   * skipped via HAVING, never labeled with a guess). tool.use failures
   * group by toolName (null names skipped). */
  const turnErrors = db
    .prepare(
      `SELECT COALESCE(json_extract(payload, '$.errorClass'), json_extract(payload, '$.code')) AS name,
              COUNT(*) AS count
       FROM session_events
       WHERE type = 'turn.error' AND date(ts) >= ? AND date(ts) <= ?
       GROUP BY name
       HAVING name IS NOT NULL AND name != ''
       ORDER BY count DESC, name ASC LIMIT 10`,
    )
    .all(firstDay, lastDay) as StatsHealthRow[];
  const toolFailures = db
    .prepare(
      `SELECT json_extract(payload, '$.toolName') AS name, COUNT(*) AS count
       FROM session_events
       WHERE type = 'tool.use' AND json_extract(payload, '$.ok') = 0
         AND date(ts) >= ? AND date(ts) <= ?
       GROUP BY name
       HAVING name IS NOT NULL AND name != ''
       ORDER BY count DESC, name ASC LIMIT 10`,
    )
    .all(firstDay, lastDay) as StatsHealthRow[];

  return {
    months,
    totals,
    peak,
    series,
    models,
    health: {
      turnErrors: turnErrors.map((row) => ({ name: row.name as string, count: row.count })),
      toolFailures: toolFailures.map((row) => ({ name: row.name as string, count: row.count })),
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * ROUND-98 (R98-I2, owner: "clear-all-data"): DELETE /usage/data's storage
 * half — wipes the append-only usage LEDGER and NOTHING else. Returns the
 * SQLite `changes` count (the number of usage events deleted, surfaced as
 * the panel's "Cleared N usage events" line).
 *
 * CLEARED — every row of usage_events, i.e. the ledger's whole memory:
 * the token counts (input / output / cached), the costs, the per-model +
 * per-provider + per-key-slot history, the ROUND-83 provider-call counts,
 * the origin tags, and the per-session usage joins (every usage surface —
 * the dashboard chart, the /usage screen, the stats panel, the context
 * meter's session totals — reads this one table, so they all reset to
 * zero together, honestly).
 *
 * NOT touched: sessions and session_events (the conversations and their
 * event log), agents, providers and their API keys, projects,
 * notifications, memory, and settings — the ledger is a side table the
 * rest of the app never depends on for correctness.
 */
export function clearUsageData(db: SqliteDatabase): number {
  const result = db.prepare("DELETE FROM usage_events").run();
  return result.changes;
}

