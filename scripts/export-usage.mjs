#!/usr/bin/env node
// scripts/export-usage.mjs
//
// R51-e (usage page): export a PUBLIC-SAFE usage snapshot from the app's
// SQLite DB into `usage.json` for the DASHBOARD status site's Usage page.
//
// What it reads (schema: agent-core/src/storage/migrations/*.sql):
//   projects        — id, name, created_at
//   sessions        — id, project_id, status, title, created_at, updated_at,
//                     parent_session_id (sub-agent link), sub_role
//   usage_events    — the per-provider-call ledger: input/output/cached
//                     tokens, cost_usd, model, ts (one row per model call)
//   session_events  — append-only log; tool calls live here as type='tool.use'
//                     events with payload {toolName, ok, ...}
//
// What it NEVER exports: message bodies, file contents, tool arguments,
// root paths, internal ids. Session/project ids are replaced with short
// deterministic hashes; titles run through a sanitizer (trim to 80 chars,
// strip secrets/paths/emails/hosts/internal ids) with a hard denylist that
// redacts the whole field to "[redacted]" on any secret-like hit. The final
// serialized JSON is scanned again with the DASHBOARD build's denylist
// patterns (plus extras) before the file is written — fail closed.
//
// Usage:
//   node scripts/export-usage.mjs [--db <path>] [--out <path>]
//   pnpm usage:export                      (same, via package.json)
//
//   --db   SQLite file to read. Default: .dev/acute.db (the dev DB that
//          scripts/dev.mjs provisions). Env override: ACUTE_DB_PATH.
//          CLI flag wins over env, env wins over default.
//   --out  Output JSON path. Default: <repoRoot>/usage.json.
//
// Dependencies: none at the repo root. better-sqlite3 is loaded from
// agent-core/node_modules (the only workspace package that installs it) via
// createRequire — an ESM-safe require() rooted at this file, with a plain
// require("better-sqlite3") fallback for layouts where it is hoisted.
// The DB is opened READ-ONLY; if the live WAL blocks a readonly open
// (busy/locked), the db + -wal + -shm files are copied to a temp dir and the
// copy is read instead — the source DB is never written to.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const out = { db: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "usage: node scripts/export-usage.mjs [--db <sqlite path>] [--out <json path>]\n" +
      "  db default : ACUTE_DB_PATH env, else .dev/acute.db\n" +
      "  out default: usage.json at the repo root",
  );
  process.exit(0);
}

const DB_PATH = resolve(args.db ?? process.env.ACUTE_DB_PATH ?? join(ROOT, ".dev", "acute.db"));
const OUT_PATH = resolve(args.out ?? join(ROOT, "usage.json"));

if (!existsSync(DB_PATH)) {
  console.error(`database not found: ${DB_PATH}`);
  console.error("pass --db <path> or set ACUTE_DB_PATH (default is the dev DB at .dev/acute.db)");
  process.exit(1);
}

/* ── better-sqlite3 (from agent-core/node_modules; ESM-safe) ─────────────── */
const require = createRequire(import.meta.url);
function loadBetterSqlite() {
  const candidates = [
    join(ROOT, "agent-core", "node_modules", "better-sqlite3"),
    "better-sqlite3",
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      return require(c);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    "better-sqlite3 not found — run `pnpm install` first (it lives in agent-core/node_modules). " +
      `Last error: ${lastErr && lastErr.message}`,
  );
}

/** Open readonly. If the live WAL blocks a readonly open, read a temp copy. */
function openDatabase(path) {
  const Database = loadBetterSqlite();
  try {
    return new Database(path, { readonly: true });
  } catch (err) {
    const tmp = mkdtempSync(join(tmpdir(), "acute-usage-"));
    const copy = join(tmp, "snapshot.db");
    copyFileSync(path, copy);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        copyFileSync(path + suffix, copy + suffix);
      } catch {
        /* no wal/shm — fine */
      }
    }
    const db = new Database(copy, { readonly: true });
    db.__tmpdir = tmp; // cleaned up in finally
    console.warn(`readonly open failed (${err.message}); reading a temp copy instead`);
    return db;
  }
}

/* ── public-safe id hashing ──────────────────────────────────────────────── */
/** FNV-1a 32-bit → 8-char base36. Deterministic, short, non-reversible-ish:
 *  internal ids (sess_…/agt_…/prj_…) never leave the machine as-is — the
 *  DASHBOARD build's denylist blocks those prefixes, and we don't want them
 *  public anyway. Collisions at this scale are ~0 and still checked below. */
function publicId(raw, kind) {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return kind + h.toString(36).padStart(7, "0").slice(-8);
}

const seenIds = new Set();
function uniquePublicId(raw, kind) {
  let id = publicId(raw, kind);
  let n = 1;
  while (seenIds.has(id)) {
    id = publicId(`${raw}#${n}`, kind);
    n += 1;
  }
  seenIds.add(id);
  return id;
}

/* ── sanitizers ──────────────────────────────────────────────────────────── */
/** Hard denylist: any hit redacts the WHOLE field to "[redacted]". */
const SECRET_PATTERNS = [
  /sk-or-[A-Za-z0-9_-]{8,}/i,
  /github_pat_[A-Za-z0-9_]+/i,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[A-Fa-f0-9]{32,}/, // long hex run
  /[A-Za-z0-9+/]{40,}={0,2}/, // long base64 run
];

/** Soft scrub: strip/neutralize the matched bits, keep the rest. */
const SCRUB = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b(?:sess|agt|prj|mem)_[A-Za-z0-9-]{6,}/gi, "[id]"],
  [/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?/gi, "[host]"],
  [/ntfy\.sh\S*/gi, "[endpoint]"],
  // absolute paths (posix + windows) — /home/…, C:\Users\…, /tmp/…, …
  [/(?:[A-Za-z]:\\[^\s"'<>|]*|\/(?:home|Users|tmp|var|opt|etc|root|mnt|media|srv|usr)\/[^\s"'<>|]*)/g, "[path]"],
];

const MAX_TITLE = 80;

function sanitizeText(raw, maxLen = MAX_TITLE) {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return "";
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return "[redacted]";
  }
  let out = text;
  for (const [re, rep] of SCRUB) out = out.replace(re, rep);
  out = out.replace(/\s{2,}/g, " ").trim();
  if (out.length > maxLen) {
    const cut = out.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    out = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "") + "…";
  }
  return out;
}

function sanitizeTitle(raw) {
  return sanitizeText(raw) || "(untitled)";
}

/* ── the export's own denylist gate (mirrors DASHBOARD build.mjs + extras) ── */
const EXPORT_DENY = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "token pattern"],
  [/github_pat_/, "fine-grained token prefix"],
  [/sk-[A-Za-z0-9_-]{16,}/, "api-key pattern"],
  [/github\.com\/[A-Za-z0-9_.-]+:[^@\s/"']+@/, "token-in-URL"],
  [/C:\\Users\\|\/home\/[a-z]+\//, "internal filesystem path"],
  [/\b(agt_|sess_|prj_)[a-z0-9-]{6,}/i, "internal id prefix"],
  [/localhost:\d{4,5}|127\.0\.0\.1:\d{4,5}/, "dev port"],
  [/ntfy\.sh/, "notification endpoint"],
  [/AKIA[0-9A-Z]{16}/, "AWS key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/[A-Fa-f0-9]{32,}/, "long hex run"],
  [/[A-Za-z0-9_]{90,}/, "suspicious secret-like run"],
];

function assertPublicSafe(serialized) {
  const hits = EXPORT_DENY.map(([re, why]) => (re.test(serialized) ? why : null)).filter(Boolean);
  if (hits.length) {
    console.error(`PUBLIC-SAFETY GATE: usage.json would contain denied patterns: ${hits.join(", ")}`);
    console.error("nothing was written — tighten the sanitizer, never the gate");
    process.exit(1);
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoOrNull = (v) => (v && !Number.isNaN(Date.parse(v)) ? v : null);
const ts = (v) => (v && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : 0);
const round2 = (v) => Math.round(v * 100) / 100;

function emptyTokens() {
  return { input: 0, output: 0, cached: 0 };
}

function addTokens(acc, row) {
  acc.input += num(row.input_tokens ?? row.input ?? 0);
  acc.output += num(row.output_tokens ?? row.output ?? 0);
  acc.cached += num(row.cached_input_tokens ?? row.cached ?? 0);
  return acc;
}

function topByValue(map, keyFn) {
  let best = null;
  let bestVal = -Infinity;
  for (const v of map.values()) {
    const val = keyFn(v);
    if (val > bestVal) {
      bestVal = val;
      best = v;
    }
  }
  return best;
}

function sortedToolCalls(map) {
  return [...map.entries()]
    .map(([tool, m]) => ({ tool, count: m.count, failures: m.failures }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/** Project colors ride along as-is when they are a clean 6-digit hex — they're
 *  a UI palette, never data — anything else falls back to the brand accent. */
function safeColor(raw) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(raw ?? "")) ? String(raw).toUpperCase() : "#FF6B2C";
}

/* ── main ────────────────────────────────────────────────────────────────── */
const db = openDatabase(DB_PATH);
try {
  const required = ["projects", "sessions", "usage_events", "session_events"];
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  for (const t of required) {
    if (!tables.has(t)) {
      console.error(`table ${t} not found in ${DB_PATH} — is this an Acute database?`);
      process.exit(1);
    }
  }

  /* load rows (small tables; whole-table reads are fine and read-only) */
  const projectRows = db
    .prepare("SELECT id, name, color, created_at FROM projects ORDER BY created_at, id")
    .all();
  const sessionRows = db
    .prepare(
      "SELECT id, project_id, status, title, created_at, updated_at, parent_session_id, sub_role" +
        " FROM sessions ORDER BY created_at, id",
    )
    .all();

  const usageBySession = new Map(); // sessionId -> aggregate
  for (const r of db
    .prepare(
      "SELECT session_id, COUNT(*) requests, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens," +
        " SUM(COALESCE(cached_input_tokens, 0)) cached_input_tokens, SUM(cost_usd) cost_usd, MIN(ts) first_ts, MAX(ts) last_ts" +
        " FROM usage_events GROUP BY session_id",
    )
    .all()) {
    usageBySession.set(r.session_id, r);
  }

  const modelBySession = new Map(); // sessionId -> Map(model -> aggregate)
  for (const r of db
    .prepare(
      "SELECT session_id, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens," +
        " SUM(COALESCE(cached_input_tokens, 0)) cached_input_tokens, SUM(cost_usd) cost_usd" +
        " FROM usage_events GROUP BY session_id, model",
    )
    .all()) {
    if (!modelBySession.has(r.session_id)) modelBySession.set(r.session_id, new Map());
    modelBySession.get(r.session_id).set(r.model, r);
  }

  const toolsBySession = new Map(); // sessionId -> Map(tool -> {count, failures})
  for (const r of db
    .prepare(
      "SELECT session_id, json_extract(payload, '$.toolName') tool, COUNT(*) count," +
        " SUM(CASE WHEN json_extract(payload, '$.ok') = 0 THEN 1 ELSE 0 END) failures" +
        " FROM session_events WHERE type = 'tool.use' GROUP BY session_id, tool",
    )
    .all()) {
    if (!r.tool) continue; // malformed payload — never guess
    if (!toolsBySession.has(r.session_id)) toolsBySession.set(r.session_id, new Map());
    toolsBySession.get(r.session_id).set(r.tool, { count: num(r.count), failures: num(r.failures) });
  }

  const lastEventTs = new Map(); // sessionId -> max event ts (ms)
  for (const r of db
    .prepare("SELECT session_id, MAX(ts) m FROM session_events GROUP BY session_id")
    .all()) {
    lastEventTs.set(r.session_id, ts(r.m));
  }

  /* public ids */
  const pidOf = new Map(); // raw project id -> public id
  for (const p of projectRows) pidOf.set(p.id, uniquePublicId(p.id, "p"));
  const sidOf = new Map(); // raw session id -> public id
  for (const s of sessionRows) sidOf.set(s.id, uniquePublicId(s.id, "s"));

  /* session records */
  const sessionsByRawId = new Map();
  for (const s of sessionRows) {
    const usage = usageBySession.get(s.id);
    const models = modelBySession.get(s.id) ?? new Map();
    const tools = toolsBySession.get(s.id) ?? new Map();
    const startMs = ts(s.created_at);
    const endCandidates = [ts(s.updated_at), usage ? ts(usage.last_ts) : 0, lastEventTs.get(s.id) ?? 0];
    const endMs = Math.max(...endCandidates);
    const tokens = usage ? addTokens(emptyTokens(), usage) : emptyTokens();
    const modelRow = topByValue(models, (m) => num(m.input_tokens) + num(m.output_tokens));
    const toolCount = [...tools.values()].reduce((n, t) => n + t.count, 0);
    sessionsByRawId.set(s.id, {
      id: sidOf.get(s.id),
      title: sanitizeTitle(s.title),
      status: String(s.status ?? "queued"),
      model: modelRow ? String(modelRow.model) : null,
      startedAt: isoOrNull(s.created_at),
      endedAt: endMs > 0 ? new Date(endMs).toISOString() : null,
      durationMs: startMs > 0 && endMs >= startMs ? endMs - startMs : 0,
      tokens,
      costUsd: round2(num(usage ? usage.cost_usd : 0)),
      requests: num(usage ? usage.requests : 0),
      toolCalls: sortedToolCalls(tools),
      toolCallCount: toolCount,
      subagentCount: 0,
      isSubagent: Boolean(s.parent_session_id),
      parentId: s.parent_session_id ? (sidOf.get(s.parent_session_id) ?? null) : null,
      role: s.sub_role ? sanitizeText(s.sub_role, 24) : null,
      startMs,
      endMs,
    });
  }

  /* parent -> children (subagentCount) */
  for (const s of sessionRows) {
    if (!s.parent_session_id) continue;
    const parent = sessionsByRawId.get(s.parent_session_id);
    if (parent) parent.subagentCount += 1;
  }

  /* project groups */
  function buildProject(name, rawId, sessions, synthetic, color) {
    const mains = sessions.filter((x) => !x.isSubagent);
    const subs = sessions.filter((x) => x.isSubagent);
    const totals = {
      sessions: mains.length,
      subagents: subs.length,
      toolCalls: 0,
      requests: 0,
      costUsd: 0,
      tokens: emptyTokens(),
    };
    const toolMap = new Map();
    const modelMap = new Map();
    let first = Infinity;
    let last = -Infinity;
    for (const s of sessions) {
      totals.toolCalls += s.toolCallCount;
      totals.requests += s.requests;
      totals.costUsd = round2(totals.costUsd + s.costUsd);
      addTokens(totals.tokens, s.tokens);
      for (const t of s.toolCalls) {
        const m = toolMap.get(t.tool) ?? { count: 0, failures: 0 };
        m.count += t.count;
        m.failures += t.failures;
        toolMap.set(t.tool, m);
      }
      const models = modelBySession.get(s.rawId) ?? new Map();
      for (const m of models.values()) {
        const acc = modelMap.get(m.model) ?? { calls: 0, tokens: emptyTokens(), costUsd: 0 };
        acc.calls += num(m.calls);
        addTokens(acc.tokens, m);
        acc.costUsd = round2(acc.costUsd + num(m.cost_usd));
        modelMap.set(m.model, acc);
      }
      if (s.startMs > 0) first = Math.min(first, s.startMs);
      if (s.endMs > 0) last = Math.max(last, s.endMs);
    }
    const subTotals = {
      count: subs.length,
      toolCalls: subs.reduce((n, s) => n + s.toolCallCount, 0),
      requests: subs.reduce((n, s) => n + s.requests, 0),
      tokens: subs.reduce((acc, s) => addTokens(acc, s.tokens), emptyTokens()),
      costUsd: round2(subs.reduce((n, s) => n + s.costUsd, 0)),
    };
    return {
      id: rawId ? pidOf.get(rawId) : uniquePublicId("unassigned", "p"),
      name: sanitizeText(name, 48) || "Project",
      color: safeColor(color),
      synthetic: Boolean(synthetic),
      sessionCount: mains.length,
      firstActivity: Number.isFinite(first) ? new Date(first).toISOString() : null,
      lastActivity: last > -Infinity ? new Date(last).toISOString() : null,
      totals,
      toolCalls: sortedToolCalls(toolMap),
      subagents: subTotals,
      models: [...modelMap.entries()]
        .map(([model, m]) => ({ model: String(model), calls: m.calls, tokens: m.tokens, costUsd: m.costUsd }))
        .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
      sessions: sessions
        .map((s) => {
          const { rawId: _rawId, startMs: _startMs, endMs: _endMs, ...pub } = s;
          return pub;
        })
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    };
  }

  const sessionViews = sessionRows.map((r) => ({ ...sessionsByRawId.get(r.id), rawId: r.id }));
  const byProject = new Map();
  const unassignedSessions = [];
  for (let i = 0; i < sessionRows.length; i += 1) {
    const pid = sessionRows[i].project_id;
    const v = sessionViews[i];
    if (pid && pidOf.has(pid)) {
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(v);
    } else {
      unassignedSessions.push(v);
    }
  }

  const projects = projectRows.map((p) =>
    buildProject(p.name, p.id, byProject.get(p.id) ?? [], false, p.color),
  );
  const unassigned = unassignedSessions.length
    ? buildProject("Unassigned sessions", null, unassignedSessions, true, "#6B6660")
    : null;

  /* totals across every session (all projects) */
  const allSessions = [...sessionsByRawId.values()];
  const totals = {
    projects: projectRows.length,
    sessions: allSessions.filter((s) => !s.isSubagent).length,
    subagentSessions: allSessions.filter((s) => s.isSubagent).length,
    toolCalls: allSessions.reduce((n, s) => n + s.toolCallCount, 0),
    requests: allSessions.reduce((n, s) => n + s.requests, 0),
    tokens: allSessions.reduce((acc, s) => addTokens(acc, s.tokens), emptyTokens()),
    costUsd: round2(allSessions.reduce((n, s) => n + s.costUsd, 0)),
  };

  const globalTools = new Map();
  for (const s of allSessions) {
    for (const t of s.toolCalls) {
      const m = globalTools.get(t.tool) ?? { count: 0, failures: 0 };
      m.count += t.count;
      m.failures += t.failures;
      globalTools.set(t.tool, m);
    }
  }
  const globalModels = new Map();
  for (const v of sessionViews) {
    for (const m of (modelBySession.get(v.rawId) ?? new Map()).values()) {
      const acc = globalModels.get(m.model) ?? { calls: 0, tokens: emptyTokens(), costUsd: 0 };
      acc.calls += num(m.calls);
      addTokens(acc.tokens, m);
      acc.costUsd = round2(acc.costUsd + num(m.cost_usd));
      globalModels.set(m.model, acc);
    }
  }

  const allStarts = allSessions.map((s) => s.startMs).filter((x) => x > 0);
  const allEnds = allSessions.map((s) => s.endMs).filter((x) => x > 0);
  const rangeFrom = allStarts.length ? Math.min(...allStarts) : null;
  const rangeTo = allEnds.length ? Math.max(...allEnds) : null;

  /* activity histogram: sessions started per UTC day (for the sparkline) */
  const dayCounts = new Map();
  for (const start of allStarts) {
    const day = new Date(start).toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  const activity = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count }));

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    range: {
      from: rangeFrom ? new Date(rangeFrom).toISOString() : null,
      to: rangeTo ? new Date(rangeTo).toISOString() : null,
      days: rangeFrom && rangeTo ? Math.max(1, Math.ceil((rangeTo - rangeFrom) / 86400000)) : 0,
    },
    totals,
    tools: sortedToolCalls(globalTools),
    models: [...globalModels.entries()]
      .map(([model, m]) => ({ model: String(model), calls: m.calls, tokens: m.tokens, costUsd: m.costUsd }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
    activity,
    projects,
    unassigned,
  };

  /* public-safety gate, then write */
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  assertPublicSafe(serialized);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, serialized, "utf8");

  /* stdout summary */
  const fmt = (n) => n.toLocaleString("en-US");
  const w = (s, n) => String(s).padEnd(n);
  const line = "─".repeat(96);
  console.log(`usage snapshot → ${OUT_PATH}`);
  console.log(`  db            ${DB_PATH} (${fmt(statSync(DB_PATH).size)} bytes)`);
  console.log(`  range         ${snapshot.range.from ?? "—"} → ${snapshot.range.to ?? "—"} (${snapshot.range.days} days)`);
  console.log(line);
  console.log(
    w("project", 34) + w("sessions", 10) + w("subs", 7) + w("tools", 8) + w("requests", 10) + w("tokens in", 12) + w("tokens out", 12) + "cost",
  );
  console.log(line);
  const rows = [...projects, ...(unassigned ? [unassigned] : [])];
  for (const p of rows) {
    console.log(
      w(p.name.slice(0, 33), 34) +
        w(p.totals.sessions, 10) +
        w(p.totals.subagents, 7) +
        w(p.totals.toolCalls, 8) +
        w(p.totals.requests, 10) +
        w(fmt(p.totals.tokens.input), 12) +
        w(fmt(p.totals.tokens.output), 12) +
        `$${p.totals.costUsd.toFixed(2)}`,
    );
  }
  console.log(line);
  console.log(
    w(`TOTAL (${totals.projects} projects)`, 34) +
      w(totals.sessions, 10) +
      w(totals.subagentSessions, 7) +
      w(totals.toolCalls, 8) +
      w(totals.requests, 10) +
      w(fmt(totals.tokens.input), 12) +
      w(fmt(totals.tokens.output), 12) +
      `$${totals.costUsd.toFixed(2)}`,
  );
  console.log(`  public-safety  denylist clean · titles sanitized · no message content exported`);
} finally {
  const tmp = db.__tmpdir;
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
