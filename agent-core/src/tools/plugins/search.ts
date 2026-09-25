/**
 * ROUND-52 (R52-f): the SEARCH + INDEXING plugin — search_files / search_code
 * / index_project, moved VERBATIM from tools/index.ts buildProjectTools.
 * ROUND-96 (R96-C): search_code gained ripgrep semantics (output_mode /
 * context / regex + a .gitignore-respecting smart walk + per-file grouped
 * results with honest truncation flags) and search_files gained glob
 * patterns + mtime-desc ordering + the 100-file cap. The owner: "Its
 * searching capabilities need to be worked on properly… it should utilize
 * smarter techniques rather than checking each and every single one of the
 * files."
 * ROUND-98 (R98-F3): search_symbols joins the family — the QUERYABLE index
 * surface (the owner: "Implement grep functionality. Handle it properly.
 * Look into indexing… essential for larger projects with a lot of files,
 * folders, subfolders."). search_code is the LIVE-TREE grep; search_symbols
 * is the INDEX lookup (prefix match over names, kind filter, signature per
 * row); index_project is the manual FULL refresher. The three descriptions
 * cross-reference each other so the model always knows which leg to use.
 */
import { jsonSchema } from "ai";
import { readdirSync } from "node:fs";
import { searchCode, searchFiles } from "../fs-ops.js";
import {
  getIndexedAt,
  parseSqliteTs,
  reindexProject,
  searchIndexSymbols,
  type IndexSymbolSearchResult,
} from "../../storage/index.js";
import { AUTO_INDEX_STALE_MS } from "../../storage/auto-index.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

/** The kind vocabulary the schema's CHECK constrains (0007 migration) — the
 * search_symbols kind filter validates against THIS list, honestly, and the
 * error names the valid set (never a silent empty result for a typo'd kind). */
const SYMBOL_KINDS: readonly string[] = [
  "function",
  "class",
  "const",
  "variable",
  "import",
  "type",
  "interface",
] as const;

/** Render one index row as a model-facing line: the codebase's path:line
 * citation idiom + the kind tag + the signature (the defining source line —
 * often enough to answer "what is this?" without a read). */
function symbolLine(row: { path: string; symbol: string; kind: string; line: number; signature?: string }): string {
  const sig = row.signature !== undefined ? ` — ${row.signature}` : "";
  return `${row.path}:${row.line} [${row.kind}] ${row.symbol}${sig}`;
}

export const searchPlugin: PluginDefinition = {
  id: "core-search",
  name: "Search & Index",
  version: "1.0.0",
  description: "File-name search, content/symbol search, and the codebase indexer.",
  category: "search",
  createTools: (ctx): ToolDefinition[] => {
    const root = ctx.root;
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "search_files",
        description:
          "Find files by NAME (not content). Either query (case-insensitive substring of the path) or pattern (a glob like '**/*.ts' or 'src/**/*.tsx' — ** crosses directories, * stays within one). Results are sorted by modification time (newest first), capped at 100 with an honest truncation flag. Use it to locate files before reading or editing them; pair with search_code when you know the CONTENT but not the path.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to look for in relative paths (case-insensitive)" },
            pattern: { type: "string", description: "Glob to match paths, e.g. '**/*.ts' (mutually exclusive with query)" },
            dir: { type: "string", description: "Optional folder to search within ('' = whole project)" },
          },
          required: [],
        }),
        execute: async (input) =>
          searchFiles(
            root,
            typeof input.query === "string" ? input.query : "",
            typeof input.dir === "string" ? input.dir : undefined,
            typeof input.pattern === "string" ? { pattern: input.pattern } : undefined,
          ),
      },
      {
        name: "search_code",
        description:
          "Search file CONTENTS across the project, ripgrep-style. query is a literal substring by default (case-insensitive); set regex: true to treat it as a regular expression (the legacy '/pattern/' form still works). Results are grouped per file as file:line: text. output_mode: 'content' (default) shows matching lines; 'files_with_matches' lists one line per file with its match count (cheap targeting — then read_file or edit_file that file); 'count' shows per-file totals only. context: N (0-8) includes N lines before/after each match so you can target an edit without re-reading the file. The walk respects .gitignore, always skips node_modules/.git/dist/build, and skips binary files and files over 2MB. Use it to find where something is defined/used BEFORE reading — the precise way to target a file, not listing files one by one.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for (literal substring, or a regex when regex: true / '/pattern/')" },
            dir: { type: "string", description: "Optional folder to search within ('' = whole project)" },
            case_sensitive: { type: "boolean", description: "Match case exactly (default false = case-insensitive)" },
            whole_word: { type: "boolean", description: "Match whole words only (literal mode only; default false)" },
            regex: { type: "boolean", description: "Treat query as a regular expression (default false = literal substring)" },
            file_glob: { type: "string", description: "Glob filter on files: '*.ts' matches basenames anywhere; 'src/**/*.ts' matches paths" },
            output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "'content' (default): file:line: text rows; 'files_with_matches': one line per file with match counts; 'count': per-file totals only" },
            context: { type: "integer", description: "Lines of context before/after each match in content mode (0-8, default 0)" },
            max_results: { type: "number", description: "Max match lines to return in content mode (default 50, cap 200)" },
          },
          required: ["query"],
        }),
        execute: async (input) => {
          const query = typeof input.query === "string" ? input.query : "";
          const dir = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir : undefined;
          const caseSensitive = input.case_sensitive === true;
          const wholeWord = input.whole_word === true;
          const fileGlob = typeof input.file_glob === "string" && input.file_glob.trim() !== "" ? input.file_glob : undefined;
          const maxResults = typeof input.max_results === "number" && input.max_results > 0 ? Math.min(200, Math.floor(input.max_results)) : 50;
          // ROUND-96 (R96-C): the ripgrep parameters.
          const outputMode =
            input.output_mode === "files_with_matches" || input.output_mode === "count" ? input.output_mode : "content";
          const context = typeof input.context === "number" && input.context > 0 ? Math.min(8, Math.floor(input.context)) : 0;
          const regex = input.regex === true;
          return searchCode(root, query, dir, {
            caseSensitive,
            wholeWord,
            fileGlob,
            maxResults,
            outputMode,
            context,
            regex,
          });
        },
      },
      {
        name: "index_project",
        // ROUND-98 (R98-F3): the description now tells the AUTO-INDEX truth
        // (background refresh when stale + per-file refresh after every
        // write/edit — the tool is the MANUAL full refresher, not the only
        // path) and cross-references search_symbols (the queryable surface).
        // The old "Also enables symbol search via search_code" claim was
        // retired — search_code walks the LIVE TREE and never touched the
        // index; search_symbols is the honest index-query leg.
        description:
          "Index the project's codebase: walk the tree, extract symbols (functions, classes, constants, types, interfaces, imports) from .ts/.tsx/.js/.jsx/.py/.rs/.go/.md files, store them in the symbol index that search_symbols queries. The index also refreshes AUTOMATICALLY: a background pass re-indexes when it is missing or >10 minutes stale, and every successful write_file/edit_file re-indexes that single file — so call THIS only to force a FULL refresh NOW (new project mid-session, after large refactors, or when search_symbols says the index is stale). Returns { indexedFiles, indexedSymbols, durationMs }.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          required: [],
        }),
        execute: async () => {
          if (!toolDeps?.db) return { ok: false, output: "indexing unavailable (no db in this context)" };
          if (!toolDeps.projectId) return { ok: false, output: "indexing unavailable (no project bound to this session)" };
          const result = reindexProject(toolDeps.db, toolDeps.projectId, root);
          return {
            ok: true,
            output: `indexed ${result.indexedFiles} files, ${result.indexedSymbols} symbols in ${result.durationMs}ms. The index summary is now injected into your context for codebase awareness; query it with search_symbols.`,
          };
        },
      },
      {
        name: "search_symbols",
        // ROUND-98 (R98-F3): the owner's grep/indexing ask — the INDEX is the
        // queryable surface for "where is X defined" in a large project: no
        // tree walk, prefix match over names, kind filter, signature per row.
        // Honest staleness language in the RESULT (not the description): the
        // built-at timestamp + the index_project pointer when stale.
        description:
          "Search the project's SYMBOL INDEX for WHERE things are DEFINED (not file contents — that is search_code): query is a case-insensitive PREFIX of a symbol name (when no symbol starts with it, a substring fallback runs and the result says so); optional kind filter (function | class | const | variable | import | type | interface); each row shows path:line [kind] symbol — signature (the defining source line). Try this BEFORE search_code when hunting a definition or recall — the index answers without walking the tree. The result carries the index's built-at timestamp and an honest stale note; call index_project to force a full refresh (the index also refreshes automatically in the background and per-file after edits).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol-name prefix to look up (case-insensitive)" },
            kind: {
              type: "string",
              enum: [...SYMBOL_KINDS],
              description: "Optional kind filter: function, class, const, variable, import, type, or interface",
            },
            limit: { type: "integer", description: "Max symbols to return (default 50, cap 200)" },
          },
          required: ["query"],
        }),
        execute: async (input) => {
          if (!toolDeps?.db) return { ok: false, output: "symbol search unavailable (no db in this context)" };
          if (!toolDeps.projectId) {
            return { ok: false, output: "symbol search unavailable (no project bound to this session)" };
          }
          const query = typeof input.query === "string" ? input.query : "";
          if (query.trim() === "") {
            return { ok: false, output: "search_symbols 'query' must be a non-empty symbol-name prefix" };
          }
          const kind = typeof input.kind === "string" ? input.kind : undefined;
          if (kind !== undefined && !SYMBOL_KINDS.includes(kind)) {
            return {
              ok: false,
              output: `search_symbols 'kind' must be one of: ${SYMBOL_KINDS.join(", ")} (got '${kind}')`,
            };
          }
          const limitRaw = typeof input.limit === "number" ? input.limit : 50;
          const limit =
            Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(200, limitRaw) : 50;
          const rows: IndexSymbolSearchResult = searchIndexSymbols(toolDeps.db, toolDeps.projectId, query, limit, kind);
          // R128-W7b (FIX 9): the match-mode truth — prefix hits render exactly
          // as before (no note); contains-fallback hits say so on ONE line so
          // the mode is honest; a still-empty contains fallback gets the
          // teaching hint instead of a bare "(no matching symbols)".
          const matchMode = rows.matchMode;
          const containsNote =
            matchMode === "contains" && rows.length > 0
              ? `(${rows.length} symbol${rows.length === 1 ? "" : "s"} match by substring — symbol search is prefix-first)\n`
              : "";
          // The HONEST freshness header: the built-at timestamp from the rows
          // themselves (MAX(ts)), plus the stale/empty note when the index is
          // older than the auto-index horizon or has nothing for this project
          // while the root has files (the honest "empty" case — a project with
          // no indexable files would say "0 symbols", not "stale").
          const indexedAt = getIndexedAt(toolDeps.db, toolDeps.projectId);
          const indexedAtMs = indexedAt !== null ? parseSqliteTs(indexedAt) : null;
          const stale =
            indexedAt === null ||
            indexedAtMs === null ||
            Date.now() - indexedAtMs > AUTO_INDEX_STALE_MS;
          const header =
            `symbol index (built at ${indexedAtMs !== null ? new Date(indexedAtMs).toISOString() : "unknown"}) — ` +
            `${rows.length} match${rows.length === 1 ? "" : "es"} for '${query.trim()}'${kind !== undefined ? ` (kind: ${kind})` : ""}`;
          const lines = rows.map((r) => symbolLine(r));
          if (rows.length >= limit) {
            lines.push(`…[capped at ${limit} results — narrow the query or raise the limit (max 200)]…`);
          }
          let note = "";
          if (indexedAt === null) {
            // Empty index: only call it stale when the project actually has
            // files (a shallow readdir — one call, cheap). An empty project's
            // empty index is CORRECT, not stale.
            let rootHasFiles = false;
            try {
              rootHasFiles = readdirSync(root).some((name) => !name.startsWith("."));
            } catch {
              /* unreadable root — report the note anyway (honest: nothing indexed) */
              rootHasFiles = true;
            }
            if (rootHasFiles) {
              note =
                `note: the symbol index is empty for this project (nothing indexed yet) — ` +
                `call index_project to build it now (it also refreshes automatically in the background)`;
            }
          } else if (stale) {
            note =
              `note: the index is stale (built at ${indexedAtMs !== null ? new Date(indexedAtMs).toISOString() : indexedAt}, ` +
              `more than 10 minutes ago) — call index_project to refresh it; edits re-index touched files automatically`;
          }
          // R128-W7b (FIX 9): the still-empty body teaches the matching model
          // (prefix-first + the contains fallback) and points at search_code
          // for CONTENT search — the ledger's "0 matches, no hint" complaint.
          const body =
            lines.length > 0
              ? lines.join("\n")
              : matchMode === "contains"
                ? "(no matching symbols — matching is PREFIX-first with a contains fallback; for content search use search_code)"
                : "(no matching symbols)";
          return {
            ok: true,
            output:
              note !== ""
                ? `${header}\n${containsNote}${body}\n${note}`
                : `${header}\n${containsNote}${body}`,
          };
        },
      },
    ];
  },
};
