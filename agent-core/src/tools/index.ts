/**
 * Agentic file tools (Agentic Coding MVP): the tool set handed to the model
 * so it can actually work in a project — list, read, write, edit. Every tool
 * is PATH-CONTAINMENT SANDBOXED to the project root: relative paths resolve
 * inside the root, and any escape (`..` traversal, absolute paths, drive
 * letters) is rejected. Shell execution and anything outside the root are
 * denied outright (denylist-supreme; the interactive approval modal lands
 * with Phase 3 — see docs/runbooks/plan-agentic-mvp.md).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";
import { jsonSchema, type ToolSet } from "ai";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import { runCommand } from "./exec.js";

export interface ToolResult {
  ok: boolean;
  /** Human/model-facing outcome (already JSON-ish string for chat tools). */
  output: string;
}

/** Maximum bytes a single read returns (keeps context windows sane). */
const MAX_READ_BYTES = 256 * 1024;
/** Directory listing depth + entry caps. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 500;
/** Ignored directory names when walking the tree. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__"]);

/* ── Explorer support (REST) ─────────────────────────────────────────────── */

export interface TreeNode {
  name: string;
  type: "file" | "folder";
  path: string;
  /** Line-ish size hint for the UI (bytes for files). */
  size?: number;
  children?: TreeNode[];
}

/** Recursive tree for the explorer panel (caps protect huge workspaces). */
export function projectTree(root: string): TreeNode[] {
  return walkDir(root, "", 0);
}

function walkDir(absBase: string, relative: string, depth: number): TreeNode[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(join(absBase, relative));
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const name of entries.slice(0, MAX_ENTRIES)) {
    const relPath = relative === "" ? name : `${relative}/${name}`;
    const absPath = join(absBase, relPath);
    try {
      const stats = statSync(absPath);
      if (stats.isDirectory()) {
        if (IGNORED_DIRS.has(name) || name.startsWith(".") && name !== ".github") continue;
        nodes.push({
          name,
          type: "folder",
          path: relPath,
          children: walkDir(absBase, relPath, depth + 1),
        });
      } else {
        nodes.push({ name, type: "file", path: relPath, size: stats.size });
      }
    } catch {
      // Unreadable entry — skip silently.
    }
  }
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
  );
  return nodes;
}

/**
 * Resolve a user/model-supplied relative path inside the root.
 * Returns the absolute path, or an error string when containment fails.
 */
export function resolveInsideRoot(root: string, relative: string): { abs: string } | { error: string } {
  const cleaned = relative.trim().replaceAll("\\", "/");
  if (cleaned === "" || cleaned === ".") return { abs: root };
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    return { error: `path must be RELATIVE to the project root (got '${relative}')` };
  }
  const normalized = posix.normalize(cleaned);
  if (normalized.startsWith("..") || normalized === ".." || normalized.includes("../")) {
    return { error: `path escapes the project root (got '${relative}')` };
  }
  return { abs: join(root, ...normalized.split("/")) };
}

function toRelative(root: string, abs: string): string {
  return abs.slice(root.length).replace(/^[\\/]/, "");
}

/** list_dir — entries of a folder (name, type, size). */
export function listDir(root: string, relative: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  let entries: string[];
  try {
    entries = readdirSync(resolved.abs);
  } catch {
    return { ok: false, output: `cannot list '${relative}': not a readable directory` };
  }
  const lines = entries.slice(0, MAX_ENTRIES).map((name) => {
    try {
      const stats = statSync(join(resolved.abs, name));
      return `${stats.isDirectory() ? "dir " : "file"} ${name}${stats.isDirectory() ? "/" : ` (${stats.size} B)`}`;
    } catch {
      return `file ${name}`;
    }
  });
  return { ok: true, output: lines.length > 0 ? lines.join("\n") : "(empty directory)" };
}

/** read_file — text content, size-capped. */
export function readFile(root: string, relative: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  try {
    const stats = statSync(resolved.abs);
    if (stats.isDirectory()) return { ok: false, output: `'${relative}' is a directory — use list_dir` };
    const buffer = readFileSync(resolved.abs);
    const clipped = buffer.length > MAX_READ_BYTES;
    const content = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
    return {
      ok: true,
      output: clipped ? `${content}\n…[truncated at ${MAX_READ_BYTES} bytes]` : content,
    };
  } catch {
    return { ok: false, output: `cannot read '${relative}': no such file` };
  }
}

/** write_file — create or overwrite (parent folders auto-created). */
export function writeFile(root: string, relative: string, content: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  try {
    mkdirSync(resolved.abs.substring(0, resolved.abs.lastIndexOf(sep)), { recursive: true });
    writeFileSync(resolved.abs, content, "utf8");
    return { ok: true, output: `wrote ${content.length} bytes to '${toRelative(root, resolved.abs)}'` };
  } catch (error) {
    return {
      ok: false,
      output: `cannot write '${relative}': ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/**
 * edit_file — replace the FIRST exact occurrence of oldString with newString
 * (Cline-style surgical edit; fails loudly when the anchor is absent or
 * ambiguous counts are requested).
 */
export function editFile(root: string, relative: string, oldString: string, newString: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  let content: string;
  try {
    content = readFileSync(resolved.abs, "utf8");
  } catch {
    return { ok: false, output: `cannot edit '${relative}': no such file` };
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return { ok: false, output: `edit failed: oldString not found in '${relative}'` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      output: `edit failed: oldString matches ${occurrences} times in '${relative}' — provide a longer unique anchor`,
    };
  }
  writeFileSync(resolved.abs, content.replace(oldString, newString), "utf8");
  return { ok: true, output: `edited '${toRelative(root, resolved.abs)}' (1 replacement)` };
}

/* ── Round-14 additions: create_dir / delete_file / search_files ─────────── */

/** create_dir — create a folder (with parents) inside the project. */
export function createDir(root: string, relative: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  try {
    mkdirSync(resolved.abs, { recursive: true });
    return { ok: true, output: `directory ready: '${toRelative(root, resolved.abs)}'` };
  } catch (error) {
    return {
      ok: false,
      output: `cannot create directory '${relative}': ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/** delete_file — remove ONE file inside the project. Directories are
 * refused: deleting a tree is destructive and belongs behind the Phase-3
 * approval engine, not a silent tool call.
 */
export function deleteFile(root: string, relative: string): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  if (resolved.abs === root) return { ok: false, output: "refusing to delete the project root" };
  try {
    if (statSync(resolved.abs).isDirectory()) {
      return {
        ok: false,
        output: `'${relative}' is a directory — deleting folders needs your approval (not available in this version yet)`,
      };
    }
  } catch {
    return { ok: false, output: `cannot delete '${relative}': no such file` };
  }
  try {
    unlinkSync(resolved.abs);
    return { ok: true, output: `deleted '${toRelative(root, resolved.abs)}'` };
  } catch (error) {
    return {
      ok: false,
      output: `cannot delete '${relative}': ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/** search_files — substring search over relative paths (recursive, capped,
 * same ignore rules as the explorer tree). The workhorse for "where is X".
 */
export function searchFiles(root: string, query: string, dir?: string): ToolResult {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { ok: false, output: "search_files needs a non-empty 'query'" };
  const base = dir !== undefined && dir.trim() !== "" ? resolveInsideRoot(root, dir) : ({ abs: root } as const);
  if ("error" in base) return { ok: false, output: base.error };
  const hits: string[] = [];
  const walk = (absDir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH || hits.length >= 50) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries.slice(0, MAX_ENTRIES)) {
      if (hits.length >= 50) return;
      if (IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
      const relPath = rel === "" ? name : `${rel}/${name}`;
      if (relPath.toLowerCase().includes(needle)) hits.push(relPath);
      try {
        if (statSync(join(absDir, name)).isDirectory()) walk(join(absDir, name), relPath, depth + 1);
      } catch {
        /* unreadable entry — skip */
      }
    }
  };
  walk(base.abs, base.abs === root ? "" : toRelative(root, base.abs), 0);
  if (hits.length === 0) return { ok: true, output: `no paths matching '${query}'` };
  return { ok: true, output: `${hits.length} match(es) for '${query}':\n${hits.join("\n")}` };
}

/** search_code — content search over file contents (Kilo/Cline parity).
 * Finds WHERE a string/regex is used: "where is X imported", "what calls Y".
 */
export function searchCode(root: string, query: string, dir?: string): ToolResult {
  const needle = query.trim();
  if (needle === "") return { ok: false, output: "search_code needs a non-empty 'query'" };
  const isRegex = needle.startsWith("/") && needle.endsWith("/") && needle.length > 2;
  const pattern = isRegex ? needle.slice(1, -1) : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return { ok: false, output: `invalid regex: ${needle}` };
  }
  const base = dir !== undefined && dir.trim() !== "" ? resolveInsideRoot(root, dir) : ({ abs: root } as const);
  if ("error" in base) return { ok: false, output: base.error };
  const hits: string[] = [];
  const walk = (absDir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH || hits.length >= 50) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries.slice(0, MAX_ENTRIES)) {
      if (hits.length >= 50) return;
      if (IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
      const relPath = rel === "" ? name : `${rel}/${name}`;
      try {
        const stats = statSync(join(absDir, name));
        if (stats.isDirectory()) {
          walk(join(absDir, name), relPath, depth + 1);
        } else if (stats.size < 512 * 1024) {
          const buf = readFileSync(join(absDir, name));
          if (buf.includes(0)) continue; // binary
          const content = buf.toString("utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && hits.length < 50; i++) {
            if (regex.test(lines[i])) {
              hits.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
            }
          }
        }
      } catch {
        /* unreadable — skip */
      }
    }
  };
  walk(base.abs, base.abs === root ? "" : toRelative(root, base.abs), 0);
  if (hits.length === 0) return { ok: true, output: `no content matches for '${needle}'` };
  return { ok: true, output: `${hits.length} match(es) for '${needle}':\n${hits.join("\n")}` };
}

/* ── AI SDK tool-set adapter ───────────────────────────────────────────────
 * The ChatFn hands these to generateText; each execute() returns a string the
 * model can read. Tool invocations are logged by the runtime into the session
 * event log as they stream through result.steps.
 */

type JsonSchemaFreeTool = {
  description: string;
  /** AI SDK v7 contract: raw JSON Schema must be wrapped in jsonSchema() so the
   * SDK gets its validation callables — a bare object fails at generateText
   * time with "schema is not a function" (found live in the M4 run). */
  inputSchema: ReturnType<typeof jsonSchema>;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};

export function buildProjectTools(root: string, allowedTools?: readonly string[]): ToolSet {
  const allow = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;
  const tools: Record<string, JsonSchemaFreeTool> = {
    list_dir: {
      description:
        "List the entries of a folder inside the project. Use '' for the project root. Always list before writing to discover structure.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path relative to the project root ('' = root)" },
        },
        required: [],
      }),
      execute: async (input) => listDir(root, typeof input.path === "string" ? input.path : ""),
    },
    read_file: {
      description:
        "Read a text file's content. Path is relative to the project root. Read BEFORE editing so you know the exact current text.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
        },
        required: ["path"],
      }),
      execute: async (input) =>
        readFile(root, typeof input.path === "string" ? input.path : ""),
    },
    write_file: {
      description:
        "Create a new file OR completely overwrite an existing one with the given full content. For small changes to existing files prefer edit_file.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
          content: { type: "string", description: "The complete file content to write" },
        },
        required: ["path", "content"],
      }),
      execute: async (input) =>
        writeFile(
          root,
          typeof input.path === "string" ? input.path : "",
          typeof input.content === "string" ? input.content : "",
        ),
    },
    edit_file: {
      description:
        "Replace ONE exact occurrence of oldString with newString in an existing file. The oldString must match exactly once — include enough surrounding lines to make it unique.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
          oldString: { type: "string", description: "Exact existing text to replace" },
          newString: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldString", "newString"],
      }),
      execute: async (input) =>
        editFile(
          root,
          typeof input.path === "string" ? input.path : "",
          typeof input.oldString === "string" ? input.oldString : "",
          typeof input.newString === "string" ? input.newString : "",
        ),
    },
    create_dir: {
      description:
        "Create a folder inside the project (parents created as needed). Use before writing files into a new subfolder.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path relative to the project root" },
        },
        required: ["path"],
      }),
      execute: async (input) => createDir(root, typeof input.path === "string" ? input.path : ""),
    },
    delete_file: {
      description:
        "Delete ONE file inside the project. Directories cannot be deleted with this tool (needs owner approval). Always confirm the user really asked for the deletion before calling.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root" },
        },
        required: ["path"],
      }),
      execute: async (input) => deleteFile(root, typeof input.path === "string" ? input.path : ""),
    },
    search_files: {
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
    search_code: {
      description:
        "Search the project for files whose CONTENT matches the query (case-insensitive substring or /regex/). Use it to find where a function is defined, what imports a module, where a string is used. Returns file:line: text matches.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for (or /regex/ for pattern matching)" },
          dir: { type: "string", description: "Optional folder to search within ('' = whole project)" },
        },
        required: ["query"],
      }),
      execute: async (input) =>
        searchCode(
          root,
          typeof input.query === "string" ? input.query : "",
          typeof input.dir === "string" ? input.dir : undefined,
        ),
    },
    git_status: {
      description: "Show the current git repository status: branch, staged/unstaged files, ahead/behind. Use before making changes to understand the state.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        required: [],
      }),
      execute: async () => gitStatus(root),
    },
    git_diff: {
      description: "Show git diff of the working directory (optionally for a specific file). Use to review pending changes.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          file: { type: "string", description: "Optional file path to diff (empty = all changes)" },
        },
        required: [],
      }),
      execute: async (input) =>
        gitDiff(root, typeof input.file === "string" && input.file.trim() !== "" ? input.file : undefined),
    },
    git_log: {
      description: "Show the last 20 git commits (oneline + branch decorations). Use to understand recent history.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        required: [],
      }),
      execute: async () => gitLog(root),
    },
    run_command: {
      description:
        "Run a terminal command inside the project root. Auto-approved for safe commands (ls, cat, grep, git status/diff/log, npm/pnpm test/build/lint, cargo check/build, node --version). Blocked commands return an explanation.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      }),
      execute: async (input) =>
        runCommand(root, typeof input.command === "string" ? input.command : ""),
    },
  };
  if (allow !== null) {
    for (const name of Object.keys(tools)) {
      if (!allow.has(name)) delete tools[name as keyof typeof tools];
    }
  }
  return tools as unknown as ToolSet;
}
