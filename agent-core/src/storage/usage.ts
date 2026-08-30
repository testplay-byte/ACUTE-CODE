/**
 * Usage-summary repository (SPEC §F7 dashboard): SQL aggregation over the
 * append-only `usage_events` log grouped by calendar day, zero-filled in JS
 * for days without traffic so the chart gets a dense ascending series.
 */
import type Database from "better-sqlite3";

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
}

interface SessionToolRow {
  session_id: string;
  tool: string | null;
  count: number;
  failures: number;
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

function sortedModels(map: Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number }>): DetailedUsageModel[] {
  return [...map.entries()]
    .map(([model, m]) => ({ model, calls: m.calls, tokens: m.tokens, costUsd: m.costUsd }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
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
        " MIN(ts) first_ts, MAX(ts) last_ts FROM usage_events GROUP BY session_id",
    )
    .all() as SessionUsageRow[]) {
    usageBySession.set(row.session_id, row);
  }

  const modelsBySession = new Map<string, Map<string, SessionModelRow>>();
  for (const row of db
    .prepare(
      "SELECT session_id, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens," +
        " SUM(COALESCE(cached_input_tokens, 0)) cached_input_tokens, SUM(cost_usd) cost_usd" +
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
    const modelMap = new Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number }>();
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
        const acc = modelMap.get(model.model) ?? { calls: 0, tokens: emptyUsageTokens(), costUsd: 0 };
        acc.calls += model.calls;
        addUsageTokens(acc.tokens, model);
        acc.costUsd = roundUsd(acc.costUsd + (model.cost_usd ?? 0));
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
      models: sortedModels(modelMap),
      // Newest-first so the app's capped drill-down shows the recent work
      // (the public export sorts ascending; the screen caps at 20 visible).
      sessions: sessions
        .map(({ rawId: _rawId, startMs: _startMs, endMs: _endMs, ...pub }) => pub)
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    };
  }

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
  const globalModels = new Map<string, { calls: number; tokens: DetailedUsageTokens; costUsd: number }>();
  for (const view of allViews) {
    for (const model of modelsBySession.get(view.rawId)?.values() ?? []) {
      const acc = globalModels.get(model.model) ?? { calls: 0, tokens: emptyUsageTokens(), costUsd: 0 };
      acc.calls += model.calls;
      addUsageTokens(acc.tokens, model);
      acc.costUsd = roundUsd(acc.costUsd + (model.cost_usd ?? 0));
      globalModels.set(model.model, acc);
    }
  }

  return {
    days: dayBuckets,
    totals,
    tools: sortedToolCalls(globalTools),
    models: sortedModels(globalModels),
    projects,
    generatedAt: new Date().toISOString(),
  };
}
