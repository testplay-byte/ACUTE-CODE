/**
 * ROUND-52 (R52-f): the SEARCH + INDEXING plugin — search_files / search_code
 * / index_project, moved VERBATIM from tools/index.ts buildProjectTools.
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
          "Search the project for files/folders whose PATH contains the query substring (case-insensitive). Use it to locate files before reading or editing them.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to look for in relative paths" },
            dir: { type: "string", description: "Optional folder to search within ('' = whole project)" },
          },
          required: ["query"],
        }),
        execute: async (input) =>
          searchFiles(
            root,
            typeof input.query === "string" ? input.query : "",
            typeof input.dir === "string" ? input.dir : undefined,
          ),
      },
      {
        name: "search_code",
        description:
          "Search the project for files whose CONTENT matches the query (case-insensitive substring or /regex/ by default; use case_sensitive + whole_word for precise matches). Use it to find where a function is defined, what imports a module, where a string is used. Returns file:line: text matches. Also queries the codebase index (index_project) for symbol matches if available.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for (or /regex/ for pattern matching)" },
            dir: { type: "string", description: "Optional folder to search within ('' = whole project)" },
            case_sensitive: { type: "boolean", description: "Match case exactly (default false = case-insensitive)" },
            whole_word: { type: "boolean", description: "Match whole words only (default false = substring match)" },
            file_glob: { type: "string", description: "Optional glob filter on file names, e.g. '*.ts' or '*.tsx' (default = all files)" },
            max_results: { type: "number", description: "Max matches to return (default 50, cap 200)" },
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
          return searchCode(root, query, dir, { caseSensitive, wholeWord, fileGlob, maxResults });
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
