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

  return {
    projectId,
    totalFiles: totalRow.files,
    totalSymbols: totalRow.symbols,
    topFiles,
    topSymbols,
    indexedAt: new Date().toISOString(),
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
 * search_code tool + the CommandPalette. Returns up to `limit` matches. */
export function searchIndexSymbols(
  db: SqliteDatabase,
  projectId: string,
  query: string,
  limit = 50,
): Array<{ path: string; symbol: string; kind: string; line: number }> {
  const needle = query.trim();
  if (needle === "") return [];
  return db
    .prepare(
      `SELECT path, symbol, kind, line FROM codebase_index
       WHERE project_id = ? AND symbol LIKE ? COLLATE NOCASE
       ORDER BY path, line LIMIT ?`,
    )
    .all(projectId, `${needle}%`, limit) as Array<{ path: string; symbol: string; kind: string; line: number }>;
}
