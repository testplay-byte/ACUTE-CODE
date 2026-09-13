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
 */
import { jsonSchema } from "ai";
import { searchCode, searchFiles } from "../fs-ops.js";
import { reindexProject } from "../../storage/index.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

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
        description:
          "Index the project's codebase: walk the tree, extract symbols (functions, classes, constants, types, interfaces, imports) from .ts/.tsx/.js/.jsx/.py/.rs/.go/.md files, store them in the codebase_index table. Call this on the FIRST turn for a new project, or after large refactors. Subsequent turns get an index summary injected into context (codebase awareness). Also enables symbol search via search_code. Returns { indexedFiles, indexedSymbols, durationMs }.",
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
            output: `indexed ${result.indexedFiles} files, ${result.indexedSymbols} symbols in ${result.durationMs}ms. The index summary is now injected into your context for codebase awareness.`,
          };
        },
      },
    ];
  },
};
