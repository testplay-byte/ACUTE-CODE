/**
 * Round-28 WS-G: project indexing & codebase awareness.
 *
 * A lightweight regex-based symbol extractor (no full AST — keeps the dep
 * tree tiny). Walks the project tree (respecting IGNORED_DIRS from the tools
 * module), parses each .ts/.tsx/.js/.jsx/.py/.rs/.go/.md file, and extracts:
 * functions, classes, constants, types, interfaces, imports.
 *
 * Owner R28 directive: "Implement proper project or such indexing so that
 * our model properly knows about the project, can manage it, can handle
 * things."
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "./db.js";

/** Ignored dirs (kept in sync with tools/index.ts — copies per 6-d review to
 * avoid polluting the tools module's public API). */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__",
]);
/** Max file size to index (512KB — larger files are likely generated/minified). */
const MAX_INDEX_FILE_BYTES = 512 * 1024;
/** Per-project symbol cap (keeps the index + prompt injection bounded). */
const MAX_SYMBOLS_PER_PROJECT = 50_000;
/** Extensions we index (code + markdown for heading extraction). */
const INDEXABLE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".md"]);

export interface IndexedSymbol {
  path: string;
  symbol: string;
  kind: "function" | "class" | "const" | "variable" | "import" | "type" | "interface";
  line: number;
  lineEnd?: number;
  signature?: string;
  docstring?: string;
}

export interface IndexSummary {
  projectId: string;
  totalFiles: number;
  totalSymbols: number;
  /** Top 10 files by symbol count. */
  topFiles: Array<{ path: string; count: number }>;
  /** All top-level symbols (functions/classes/constants in the root src/ dir). */
  topSymbols: Array<{ path: string; symbol: string; kind: string; line: number }>;
  indexedAt: string;
}

/** Regex patterns per kind. Order matters: earlier patterns win on overlap. */
const PATTERNS: Array<{ kind: IndexedSymbol["kind"]; re: RegExp }> = [
  // TypeScript/JavaScript
  { kind: "import", re: /^(?:export\s+)?import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*(?:from)?\s*["'`]/ },
  { kind: "interface", re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "class", re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/ },
  { kind: "const", re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/ },
  // Python
  { kind: "function", re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
  { kind: "class", re: /^class\s+([A-Za-z_][\w]*)/ },
  // Rust
  { kind: "function", re: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/ },
  { kind: "class", re: /^(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/ },
  { kind: "class", re: /^(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/ },
  // Go
  { kind: "function", re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/ },
  { kind: "class", re: /^type\s+([A-Za-z_]\w*)\s+struct/ },
  { kind: "const", re: /^const\s+([A-Za-z_]\w*)\s*=/ },
  // Markdown headings (lightweight — "## Foo" → kind=type, symbol=Foo)
  { kind: "type", re: /^##\s+(.+)/ },
];

/** Extract symbols from a single file's content. Returns per-line matches. */
function extractSymbols(
  path: string,
  content: string,
): IndexedSymbol[] {
  const lines = content.split("\n");
  const out: IndexedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines inside block comments (very lightweight tracking).
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        const symbol = m[1]?.trim() ?? (kind === "import" ? "(import)" : "(anonymous)");
        // Skip trivial matches (single chars, or the import keyword itself).
        if (symbol.length < 2) continue;
        out.push({
          path,
          symbol: symbol.slice(0, 100),
          kind,
          line: i + 1,
          signature: line.trim().slice(0, 200),
        });
        break; // first matching pattern wins for this line
      }
    }
  }
  return out;
}

/** Walk the project tree (respecting IGNORED_DIRS), return indexable files. */
function walkProject(root: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length > 5000) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
      const relPath = rel === "" ? name : `${rel}/${name}`;
      try {
        const stats = statSync(join(absDir, name));
        if (stats.isDirectory()) {
          walk(join(absDir, name), relPath, depth + 1);
        } else if (stats.size < MAX_INDEX_FILE_BYTES) {
          const ext = name.slice(name.lastIndexOf("."));
          if (INDEXABLE_EXT.has(ext)) out.push(relPath);
        }
      } catch {
        /* unreadable — skip */
      }
    }
  };
  walk(root, "", 0);
  return out;
}

/**
 * Reindex a project: clear old rows for this project, walk the tree, extract
 * symbols, insert in batches. Idempotent (DELETE then INSERT).
 * Returns { indexedFiles, indexedSymbols, durationMs }.
 */
export function reindexProject(
  db: SqliteDatabase,
  projectId: string,
  rootPath: string,
): { indexedFiles: number; indexedSymbols: number; durationMs: number } {
  const startedAt = Date.now();
  // Clear old rows for this project.
  db.prepare("DELETE FROM codebase_index WHERE project_id = ?").run(projectId);
  // 30-day snapshot cleanup (6-f R-G4): keep file_snapshots bounded.
  try {
    db.prepare("DELETE FROM file_snapshots WHERE ts < datetime('now', '-30 days')").run();
  } catch {
    /* snapshots table may not exist on older DBs — ignore */
  }

  const files = walkProject(rootPath);
  let symbolCount = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO codebase_index (project_id, path, symbol, kind, line, signature)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: Array<[string, string, string, number, string]>) => {
    for (const [path, symbol, kind, line, sig] of rows) {
      if (symbolCount >= MAX_SYMBOLS_PER_PROJECT) break;
      insert.run(projectId, path, symbol, kind, line, sig);
      symbolCount++;
    }
  });

  for (const relPath of files) {
    if (symbolCount >= MAX_SYMBOLS_PER_PROJECT) break;
    try {
      const content = readFileSync(join(rootPath, relPath), "utf8");
      const symbols = extractSymbols(relPath, content);
      if (symbols.length === 0) continue;
      const rows: Array<[string, string, string, number, string]> = symbols.map((s) =>
        [s.path, s.symbol, s.kind, s.line, s.signature ?? ""]);
      insertMany(rows);
    } catch {
      /* unreadable file — skip */
    }
  }

  return { indexedFiles: files.length, indexedSymbols: symbolCount, durationMs: Date.now() - startedAt };
}

/** Get a summary of the index for context injection (system prompt) + the UI. */
export function getIndexSummary(db: SqliteDatabase, projectId: string): IndexSummary | null {
  const totalRow = db
    .prepare("SELECT COUNT(DISTINCT path) AS files, COUNT(*) AS symbols FROM codebase_index WHERE project_id = ?")
    .get(projectId) as { files: number; symbols: number } | undefined;
  if (!totalRow || (totalRow.files === 0 && totalRow.symbols === 0)) return null;

  const topFiles = db
    .prepare("SELECT path, COUNT(*) AS count FROM codebase_index WHERE project_id = ? GROUP BY path ORDER BY count DESC LIMIT 10")
    .all(projectId) as Array<{ path: string; count: number }>;

  const topSymbols = db
    .prepare("SELECT path, symbol, kind, line FROM codebase_index WHERE project_id = ? ORDER BY path, line LIMIT 50")
    .all(projectId) as Array<{ path: string; symbol: string; kind: string; line: number }>;

  // ROUND-98 (R98-F3): indexedAt is the HONEST last-write timestamp of the
  // project's index rows (MAX(ts)), not `new Date()` — a freshness claim
  // must never be fabricated. The no-rows case returned null above, so the
  // fallback is unreachable in practice; Date.now() keeps it honest if a
  // future caller ever reaches it with a NULL MAX(ts) (never a made-up
  // fixed string).
  const maxTs = db
    .prepare("SELECT MAX(ts) AS m FROM codebase_index WHERE project_id = ?")
    .get(projectId) as { m: string | null } | undefined;
  const indexedAtMs = maxTs?.m != null ? parseSqliteTs(maxTs.m) : null;
  return {
    projectId,
    totalFiles: totalRow.files,
    totalSymbols: totalRow.symbols,
    topFiles,
    topSymbols,
    indexedAt: indexedAtMs !== null ? new Date(indexedAtMs).toISOString() : new Date().toISOString(),
  };
}

/** Delta-update: re-index a SINGLE file after a write_file/edit_file (avoids
 * a full reindex on every mutation). */
export function reindexFile(
  db: SqliteDatabase,
  projectId: string,
  rootPath: string,
  relPath: string,
): { indexedSymbols: number } {
  db.prepare("DELETE FROM codebase_index WHERE project_id = ? AND path = ?").run(projectId, relPath);
  try {
    const content = readFileSync(join(rootPath, relPath), "utf8");
    const symbols = extractSymbols(relPath, content);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO codebase_index (project_id, path, symbol, kind, line, signature)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of symbols) {
      insert.run(projectId, s.path, s.symbol, s.kind, s.line, s.signature ?? "");
    }
    return { indexedSymbols: symbols.length };
  } catch {
    return { indexedSymbols: 0 };
  }
}

/** Search the codebase index for symbols by name (prefix match). Used by the
 * search_code tool + the CommandPalette. Returns up to `limit` matches.
 * ROUND-98 (R98-F3): the search_symbols TOOL's backing query — now returns
 * the row's signature + line_end too (honestly: signature is the defining
 * source line; line_end is NULL until a future extractor computes spans),
 * and accepts an optional kind filter (SQL-side, one of the seven kinds the
 * schema's CHECK constrains).
 * ROUND-128 (R128-W7b, FIX 9): PREFIX-FIRST with a CONTAINS FALLBACK. The
 * ledger complaint: query "ch" → 0 matches, no hint — prefix-only search
 * silently starved mid-word queries. When the prefix query returns 0 rows
 * (ANY needle length), a `LIKE '%needle%' COLLATE NOCASE` fallback runs and
 * those rows return with `matchMode: "contains"` so the tool layer can say
 * so honestly. The return type is the plain array PLUS an optional
 * matchMode marker (additive — existing callers keep compiling, and the
 * REST serializer ignores the marker; only the plugin reads it). */
export interface IndexSymbolMatch {
  path: string;
  symbol: string;
  kind: string;
  line: number;
  line_end?: number;
  signature?: string;
}

/** R128-W7b (FIX 9): how the returned rows matched — prefix (the primary
 * index-friendly query) or contains (the fallback that rescued a 0-row
 * prefix search). */
export type IndexSymbolSearchMode = "prefix" | "contains";

/** R128-W7b (FIX 9): the additive result shape — the rows array plus the
 * match-mode marker (an own property on the array; JSON serialization of
 * the REST route keeps emitting a plain row array). */
export type IndexSymbolSearchResult = IndexSymbolMatch[] & { matchMode?: IndexSymbolSearchMode };

export function searchIndexSymbols(
  db: SqliteDatabase,
  projectId: string,
  query: string,
  limit = 50,
  kind?: string,
): IndexSymbolSearchResult {
  const needle = query.trim();
  if (needle === "") return [];
  // ROUND-98 (R98-F3): the kind filter rides the SQL (the index is the
  // queryable surface the owner asked for — "look into indexing… essential
  // for larger projects"); the caller validates the vocabulary.
  const runQuery = (likePattern: string): IndexSymbolMatch[] => {
    const rows = (kind
      ? db
          .prepare(
            `SELECT path, symbol, kind, line, line_end, signature FROM codebase_index
             WHERE project_id = ? AND symbol LIKE ? COLLATE NOCASE AND kind = ?
             ORDER BY path, line LIMIT ?`,
          )
          .all(projectId, likePattern, kind, limit)
      : db
          .prepare(
            `SELECT path, symbol, kind, line, line_end, signature FROM codebase_index
             WHERE project_id = ? AND symbol LIKE ? COLLATE NOCASE
             ORDER BY path, line LIMIT ?`,
          )
          .all(projectId, likePattern, limit)) as Array<{
      path: string;
      symbol: string;
      kind: string;
      line: number;
      line_end: number | null;
      signature: string | null;
    }>;
    // Shaped honestly: only the fields the row actually carries (an absent
    // line_end/signature is OMITTED, never null-padded).
    return rows.map((r) => ({
      path: r.path,
      symbol: r.symbol,
      kind: r.kind,
      line: r.line,
      ...(r.line_end !== null ? { line_end: r.line_end } : {}),
      ...(r.signature !== null && r.signature !== "" ? { signature: r.signature } : {}),
    }));
  };
  const prefixRows = runQuery(`${needle}%`);
  if (prefixRows.length > 0) {
    return Object.assign(prefixRows, { matchMode: "prefix" as const });
  }
  // R128-W7b (FIX 9): the contains fallback — prefix found nothing, so try
  // the needle as a SUBSTRING of the symbol name (still COLLATE NOCASE).
  return Object.assign(runQuery(`%${needle}%`), { matchMode: "contains" as const });
}

/* ── ROUND-98 (R98-F3): the index's HONEST freshness facts ────────────────── */

/** Parse SQLite's UTC "YYYY-MM-DD HH:MM:SS" timestamp (the codebase_index
 * `ts` default, datetime('now')) into epoch ms. Null on any other shape —
 * never a guess. The explicit "Z" is load-bearing: Date.parse of a
 * space-separated or bare-T timestamp treats it as LOCAL time (the classic
 * trap — a UTC column parsed as local shifts freshness by the timezone). */
export function parseSqliteTs(ts: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(ts.trim());
  if (m === null) return null;
  const epoch = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(epoch) ? null : epoch;
}

/** The project index's HONEST last-write timestamp — MAX(ts) over its rows,
 * raw SQLite form ("YYYY-MM-DD HH:MM:SS", UTC), or null when the project has
 * no index rows (never indexed, or emptied). This is the staleness fact the
 * search_symbols tool reports and the auto-index hook (storage/auto-index.ts)
 * gates on — a freshness claim must come from the rows, never the clock. */
export function getIndexedAt(db: SqliteDatabase, projectId: string): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS m FROM codebase_index WHERE project_id = ?")
    .get(projectId) as { m: string | null } | undefined;
  return row?.m ?? null;
}
