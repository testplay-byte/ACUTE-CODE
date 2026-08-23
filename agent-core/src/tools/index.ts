/**
 * Agentic file tools (Agentic Coding MVP): the tool set handed to the model
 * so it can actually work in a project — list, read, write, edit. Every tool
 * is PATH-CONTAINMENT SANDBOXED to the project root: relative paths resolve
 * inside the root, and any escape (`..` traversal, absolute paths, drive
 * letters) is rejected. Shell execution and anything outside the root are
 * denied outright (denylist-supreme; the interactive approval modal lands
 * with Phase 3 — see docs/runbooks/plan-agentic-mvp.md).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";
import { jsonSchema, type ToolSet } from "ai";

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

export function buildProjectTools(root: string): ToolSet {
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
  };
  return tools as unknown as ToolSet;
}
