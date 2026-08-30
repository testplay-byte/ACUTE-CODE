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
import type { PermissionMode } from "shared";
import { jsonSchema, type ToolSet } from "ai";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import { runCommand } from "./exec.js";
import { writeTodo, type TodoItem } from "./todo.js";
import { webFetch, webSearch, scrubSearchQuery } from "./web.js";
// ROUND-45 (audit P0-5): web_fetch + browser_control navigate pass through
// the approval engine's host gate.
import { requestWebFetchApproval, type ApprovalRequestDeps } from "../approvals.js";
// ROUND-44 (R44-a): the agent memory tools — persistence lives in
// storage/memory.ts, the tool wrappers here.
import { memoryListTool, memoryRecallTool, memorySaveTool } from "./memory.js";
import {
  VIEWPORT_PRESETS,
  browserActiveTabSessionId,
  browserGetStateCommand,
  browserNavigateCommand,
  browserViewportCommand,
} from "../browser-proxy.js";
import { recordSnapshot } from "../storage/snapshots.js";
import { reindexProject } from "../storage/index.js";
import { SUB_ROLES, type SubRole } from "../agents/orchestrator.js";

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
 * Round-28 WS-H: extended with case_sensitive, whole_word, file_glob, max_results.
 */
export interface SearchCodeOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fileGlob?: string;
  maxResults?: number;
}
export function searchCode(root: string, query: string, dir?: string, options?: SearchCodeOptions): ToolResult {
  const needle = query.trim();
  if (needle === "") return { ok: false, output: "search_code needs a non-empty 'query'" };
  const isRegex = needle.startsWith("/") && needle.endsWith("/") && needle.length > 2;
  // wholeWord wraps the pattern in \b...\b (only for non-regex mode).
  let pattern: string;
  if (isRegex) {
    pattern = needle.slice(1, -1);
  } else {
    pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (options?.wholeWord) pattern = `\\b${pattern}\\b`;
  }
  const flags = options?.caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return { ok: false, output: `invalid regex: ${needle}` };
  }
  const maxHits = options?.maxResults ?? 50;
  const cap = Math.min(maxHits, 200);
  const globRe = options?.fileGlob ? new RegExp("^" + options.fileGlob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$", "i") : null;
  const base = dir !== undefined && dir.trim() !== "" ? resolveInsideRoot(root, dir) : ({ abs: root } as const);
  if ("error" in base) return { ok: false, output: base.error };
  const hits: string[] = [];
  const walk = (absDir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH || hits.length >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries.slice(0, MAX_ENTRIES)) {
      if (hits.length >= cap) return;
      if (IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
      const relPath = rel === "" ? name : `${rel}/${name}`;
      try {
        const stats = statSync(join(absDir, name));
        if (stats.isDirectory()) {
          walk(join(absDir, name), relPath, depth + 1);
        } else if (stats.size < 512 * 1024 && (!globRe || globRe.test(name))) {
          const buf = readFileSync(join(absDir, name));
          if (buf.includes(0)) continue; // binary
          const content = buf.toString("utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && hits.length < cap; i++) {
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

export interface ToolDeps {
  db: import("better-sqlite3").Database;
  sessionId: string;
  agentId: string;
  seq?: number;
  /** Round-28 WS-G: the project id (for codebase_index + searchIndexSymbols).
   * Optional for back-compat (older call sites that don't pass it). */
  projectId?: string;
  /** ROUND-36 (ADR-0022): forward live sub-agent status events onto the
   * parent's stream (streamed turns pass their SSE emitter). Optional. */
  emit?: (event: unknown) => void;
  /** ROUND-36: the keyring — the delegate tool builds child runs with it. */
  keyring?: import("../providers/registry.js").ProviderKeyring;
  /** ROUND-36: the chat fn for child turns (injected to avoid cycles). */
  chat?: import("../agents/chat.js").ChatFn;
  /** ROUND-50 (R50-b, owner: sub-agent panels must stream the raw live
   * response "just like the main agent"): the STREAMING adapter, forwarded by
   * prepareTurn when the parent turn runs the streamed path. Present → the
   * delegate_task tool hands it to the orchestrator and children run
   * runStreamedAgentTurn (live text/thinking deltas ride the parent's SSE as
   * subagent-event envelopes). Absent → children keep the sync step-snapshot
   * path (channel-less runs: unchanged fail-fast ask semantics). */
  chatStream?: import("../agents/chat.js").StreamChatFn;
  /** ROUND-37/R48 (approvals): any turn with a live emit channel — the
   * streamed parent turn AND sub-agent children delegated from it — may
   * pause and ask the owner for permission (a child's approvals ride the
   * parent's SSE as subagent-event envelopes; the decision route wakes the
   * child's waiter). Channel-less runs (the plain sync route, retryChild)
   * still fail fast on non-auto commands (no 120s burn). */
  interactiveApprovals?: boolean;
  /** ROUND-37: the live turn's abort signal — a pending approval denies on
   * abort (the waiter races it; the SDK alone may not cancel tool promises). */
  signal?: AbortSignal;
  /** ROUND-37: persisted-event writer — approval.requested/resolved fold
   * into the session log so the exchange renders after reload. */
  appendEvent?: (event: {
    type: "approval.requested" | "approval.resolved";
    agentId: string;
    payload: Record<string, unknown>;
  }) => void;
  /** ROUND-49: the memory master switch (settings/memory). When explicitly
   * false, the memory_save/recall/list tools are NOT registered and the
   * system prompt carries no memory digest. Undefined = enabled (default),
   * so existing call sites (tests, older paths) keep the tools. */
  memoryEnabled?: boolean;
  /** ROUND-50 (R50-c1): the session's permission mode (full/ask/plan/
   * editor), forwarded by runtime.ts prepareTurn. The tool-set RESTRICTIONS
   * (plan/editor) are applied to the allowlist BEFORE buildProjectTools
   * runs; this field carries the mode to the approval gates — "full"
   * auto-approves ask-tier decisions (denylist-supreme refusals stay hard
   * in every mode, see approvals.ts). */
  permissionMode?: PermissionMode;
}

/**
 * ROUND-50 (R50-c1): sentinel allowlist meaning "register NO tools".
 * buildProjectTools treats `undefined` AND `[]` as "ALL tools" (ADR-0019 —
 * the agent-allowlist semantic), so a mode intersection that produced an
 * EMPTY list (e.g. an explicit allowlist of only run_command in editor
 * mode) cannot be expressed as `[]`. prepareTurn passes this sentinel in
 * that case; the fake name matches no registered tool, so the model gets
 * an empty toolset. (The ROUND-40 bug was the sentinel being applied to
 * []-allowlist agents by mistake — this is the deliberate, documented use.)
 */
export const NO_TOOLS: readonly string[] = ["__none__"];

/**
 * ROUND-50 (R50-c1): the approval-gate deps every gated tool builds from
 * toolDeps (run_command, web_fetch, browser_control-navigate) — ONE builder
 * so the permissionMode forwarding can never drift between call sites.
 */
function buildApprovalDeps(toolDeps: ToolDeps): ApprovalRequestDeps {
  return {
    db: toolDeps.db,
    sessionId: toolDeps.sessionId,
    agentId: toolDeps.agentId,
    interactive: toolDeps.interactiveApprovals === true,
    ...(toolDeps.permissionMode !== undefined ? { permissionMode: toolDeps.permissionMode } : {}),
    ...(toolDeps.projectId !== undefined ? { projectId: toolDeps.projectId } : {}),
    ...(toolDeps.emit !== undefined ? { emit: toolDeps.emit } : {}),
    ...(toolDeps.signal !== undefined ? { signal: toolDeps.signal } : {}),
    ...(toolDeps.appendEvent !== undefined ? { appendEvent: toolDeps.appendEvent } : {}),
  };
}

export async function buildProjectTools(root: string, allowedTools?: readonly string[], deps?: ToolDeps): Promise<ToolSet> {
  const allow = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;
  const toolDeps = deps;
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
      execute: async (input) => {
        const relPath = typeof input.path === "string" ? input.path : "";
        const newContent = typeof input.content === "string" ? input.content : "";
        // Record the "before" state for checkpoint/revert
        let beforeContent: string | null = null;
        try {
          const resolved = resolveInsideRoot(root, relPath);
          if (!("error" in resolved)) {
            beforeContent = readFileSync(resolved.abs, "utf8");
          }
        } catch { /* new file — before = null */ }
        const result = writeFile(root, relPath, newContent);
        if (result.ok && toolDeps) {
          recordSnapshot(toolDeps.db, {
            sessionId: toolDeps.sessionId,
            seq: toolDeps.seq ?? 0,
            path: relPath,
            beforeContent,
            afterContent: newContent,
            toolName: "write_file",
          });
        }
        return result;
      },
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
      execute: async (input) => {
        const relPath = typeof input.path === "string" ? input.path : "";
        // Record the "before" state
        let beforeContent: string | null = null;
        try {
          const resolved = resolveInsideRoot(root, relPath);
          if (!("error" in resolved)) beforeContent = readFileSync(resolved.abs, "utf8");
        } catch { /* file doesn't exist — edit will fail anyway */ }
        const result = editFile(
          root,
          relPath,
          typeof input.oldString === "string" ? input.oldString : "",
          typeof input.newString === "string" ? input.newString : "",
        );
        if (result.ok && toolDeps && beforeContent !== null) {
          let afterContent: string | null = null;
          try {
            const resolved = resolveInsideRoot(root, relPath);
            if (!("error" in resolved)) afterContent = readFileSync(resolved.abs, "utf8");
          } catch { /* */ }
          recordSnapshot(toolDeps.db, {
            sessionId: toolDeps.sessionId,
            seq: toolDeps.seq ?? 0,
            path: relPath,
            beforeContent,
            afterContent,
            toolName: "edit_file",
          });
        }
        return result;
      },
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
      execute: async (input) => {
        const relPath = typeof input.path === "string" ? input.path : "";
        let beforeContent: string | null = null;
        try {
          const resolved = resolveInsideRoot(root, relPath);
          if (!("error" in resolved)) beforeContent = readFileSync(resolved.abs, "utf8");
        } catch { /* */ }
        const result = deleteFile(root, relPath);
        if (result.ok && toolDeps) {
          recordSnapshot(toolDeps.db, {
            sessionId: toolDeps.sessionId,
            seq: toolDeps.seq ?? 0,
            path: relPath,
            beforeContent,
            afterContent: null,
            toolName: "delete_file",
          });
        }
        return result;
      },
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
        "Run a terminal command inside the project root. Read-only and build/test commands run automatically (ls, cat, grep, git status/diff/log, npm/pnpm test/build/lint, cargo check/build) — but ONLY while every path they touch stays INSIDE the project root (anything under /, ~, .. or another drive asks first). Any other command also asks the owner for permission and waits for their decision — blocked commands (sudo, rm -rf, curl, dev servers) are refused outright.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      }),
      execute: async (input) =>
        runCommand(
          root,
          typeof input.command === "string" ? input.command : "",
          toolDeps !== undefined ? buildApprovalDeps(toolDeps) : undefined,
        ),
    },
    todo_write: {
      description:
        "Write the FULL todo list for the current task (snapshot, not a delta). Use for multi-step tasks to track progress. Each item: {content, status: 'pending'|'in_progress'|'completed'}. Provide ALL items every time.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "What needs to be done (one line)" },
                status: { type: "string", description: "pending | in_progress | completed" },
              },
              required: ["content", "status"],
            },
            description: "The complete todo list snapshot",
          },
        },
        required: ["todos"],
      }),
      execute: async (input) => {
        const deps = toolDeps;
        if (!deps) return { ok: false, output: "todo tracking unavailable in this context" };
        const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
        return writeTodo(deps, todos);
      },
    },
    web_fetch: {
      description:
        "Fetch a public http(s) URL and return its content as readable text. Documentation and source hosts (github.com, raw.githubusercontent.com, npmjs.com, developer.mozilla.org, react.dev, vitejs.dev, typescriptlang.org, nodejs.org, tauri.app, docs.rs, crates.io, pypi.org, docs.python.org, stackoverflow.com and more) fetch without friction; any OTHER host asks the owner for permission first (they can always-allow the host for the project). Use this to read documentation pages, RFCs, GitHub raw files, blog posts, and any public web page. HTML is stripped to readable text (scripts/styles removed); non-HTML content is returned raw. Response is capped at 16KB.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          url: { type: "string", description: "The absolute http(s) URL to fetch" },
        },
        required: ["url"],
      }),
      execute: async (input) => {
        const url = typeof input.url === "string" ? input.url : "";
        // ROUND-45 (P0-5): every outbound fetch is host-gated. No approval
        // channel at all (bare/test builds) = fail-closed.
        if (toolDeps === undefined) {
          return { ok: false, output: "web_fetch unavailable: no approval channel in this context" };
        }
        const approvalDeps: ApprovalRequestDeps = buildApprovalDeps(toolDeps);
        const gate = await requestWebFetchApproval(approvalDeps, url);
        if (!gate.allowed) {
          return { ok: false, output: `web_fetch blocked: ${gate.note}` };
        }
        return webFetch(url);
      },
    },
    web_search: {
      description:
        "Search the REAL web for a query and return ranked results (title, url, snippet) via DuckDuckGo — no API key needed, no approval friction (it only talks to DuckDuckGo/Wikipedia, and the query is secret-scrubbed before it leaves). Use to find documentation, API references, library usage examples, GitHub issues, changelogs, or explanations of technical concepts. Returns up to 8 results. If both DuckDuckGo endpoints are unavailable it falls back to encyclopedia (Wikipedia) results and says so in the output — for reading a specific known URL, use web_fetch instead.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: { type: "string", description: "The search query (a few words works best)" },
        },
        required: ["query"],
      }),
      execute: async (input) => {
        const query = typeof input.query === "string" ? input.query : "";
        // ROUND-45 (P0-5): the query is the only model-controlled part that
        // leaves the machine — scrub keyring values + key-shaped strings.
        const secrets = toolDeps?.keyring !== undefined ? toolDeps.keyring.list() : [];
        return webSearch(scrubSearchQuery(query, secrets));
      },
    },
    browser_control: {
      description:
        "Control the user's EMBEDDED BROWSER PANEL — a real in-app web browser the user watches live. Actions: navigate (open/change the page; absolute http(s) URL — documentation/source hosts like github.com navigate freely, other hosts ask the owner for permission first), back | forward | reload (walk that tab's history), set_viewport (change the display size the user sees — test responsive layouts at phone/tablet/desktop sizes), get_state (read currentUrl, title, viewport, canBack, canForward). Presets: mobile-sm 375×667, mobile-md 390×844, tablet 768×1024, laptop 1280×800, desktop 1440×900, full-hd 1920×1080; or custom width 200-3840 × height 200-4320, zoom 0.25-3, rotate swaps width/height. sessionId optional — defaults to the browser tab the user is currently viewing. Viewport/page changes appear LIVE in the user's panel; announce them in one line. To read page text into your own context, web_fetch is usually more reliable than the panel (it renders through a proxy).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "navigate | back | forward | reload | set_viewport | get_state",
            enum: ["navigate", "back", "forward", "reload", "set_viewport", "get_state"],
          },
          url: { type: "string", description: "Absolute http(s) URL to open (action=navigate)" },
          preset: {
            type: "string",
            description: "Display-size preset (action=set_viewport)",
            enum: [...Object.keys(VIEWPORT_PRESETS), "custom"],
          },
          width: { type: "number", description: "Viewport width 200-3840 (action=set_viewport, custom size)" },
          height: { type: "number", description: "Viewport height 200-4320 (action=set_viewport, custom size)" },
          zoom: { type: "number", description: "Panel render zoom 0.25-3 (action=set_viewport)" },
          rotate: { type: "boolean", description: "Swap width/height, e.g. landscape phone (action=set_viewport)" },
          sessionId: {
            type: "string",
            description: "Browser tab session id — omit to target the tab the user is viewing",
          },
        },
        required: ["action"],
      }),
      execute: async (input) => {
        const action = typeof input.action === "string" ? input.action : "";
        // Mirror of the backend's SESSION_ID_RE (browser-proxy.ts) — the
        // command entry points trust their caller, so validate here.
        const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
        const explicit = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        if (explicit !== "" && !SESSION_ID_RE.test(explicit)) {
          return { ok: false, output: "browser_control: sessionId must be alphanumeric/-/./_ (max 64 chars)" };
        }
        // Default target: the tab the user is looking at (LRU tail of the
        // sidecar's browser-session store); falls back to the shared
        // "agent" session when no browser tab has been opened yet.
        const activeTab = browserActiveTabSessionId();
        const sessionId = explicit !== "" ? explicit : (activeTab ?? "agent");
        const noTabHint =
          activeTab === null && explicit === ""
            ? " (note: no embedded browser tab is open — this state is not visible to the user yet)"
            : "";

        if (action === "navigate") {
          const url = typeof input.url === "string" ? input.url.trim() : "";
          if (url === "") return { ok: false, output: "browser_control: action navigate requires url" };
          // ROUND-45 (audit P0-5): agent-driven navigation is host-gated
          // exactly like web_fetch (the panel then renders through the
          // server-side proxy). Malformed/non-http URLs fall through to the
          // shape validation below (its error is the better one); no approval
          // channel at all = fail-closed for http(s) too.
          if (/^https?:\/\//i.test(url)) {
            if (toolDeps === undefined) {
              return { ok: false, output: "browser_control: navigate unavailable — no approval channel in this context" };
            }
            const approvalDeps: ApprovalRequestDeps = buildApprovalDeps(toolDeps);
            const gate = await requestWebFetchApproval(approvalDeps, url, "browser_control");
            if (!gate.allowed) {
              return { ok: false, output: `browser_control: navigate blocked — ${gate.note}` };
            }
          }
          const result = browserNavigateCommand(sessionId, { url });
          if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
          return {
            ok: true,
            output: `navigated the embedded browser to ${result.entry?.url ?? url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.${noTabHint}`,
          };
        }
        if (action === "back" || action === "forward" || action === "reload") {
          const result = browserNavigateCommand(sessionId, { direction: action });
          if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
          if (result.action === "noop" || result.entry === null) {
            return { ok: true, output: `browser_control: ${action} did nothing (history boundary; index ${result.index})` };
          }
          return {
            ok: true,
            output: `${action} → ${result.entry.url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.`,
          };
        }
        if (action === "set_viewport") {
          const patch: { preset?: unknown; width?: unknown; height?: unknown; zoom?: unknown; rotate?: unknown } = {};
          if (input.preset !== undefined) patch.preset = input.preset;
          if (input.width !== undefined) patch.width = input.width;
          if (input.height !== undefined) patch.height = input.height;
          if (input.zoom !== undefined) patch.zoom = input.zoom;
          if (input.rotate !== undefined) patch.rotate = input.rotate;
          if (Object.keys(patch).length === 0) {
            return {
              ok: false,
              output: "browser_control: set_viewport requires preset and/or width/height/zoom/rotate",
            };
          }
          const result = browserViewportCommand(sessionId, patch);
          if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
          const v = result.viewport;
          return {
            ok: true,
            output: `viewport set to ${v.width}×${v.height} (${v.preset}, zoom ${v.zoom}${v.rotate ? ", rotated" : ""}). The user's browser panel resizes live.${noTabHint}`,
          };
        }
        if (action === "get_state") {
          return { ok: true, output: JSON.stringify(browserGetStateCommand(sessionId)) };
        }
        return {
          ok: false,
          output: `browser_control: unknown action '${action}' (navigate | back | forward | reload | set_viewport | get_state)`,
        };
      },
    },
    index_project: {
      description:
        "Index the project's codebase: walk the tree, extract symbols (functions, classes, constants, types, interfaces, imports) from .ts/.tsx/.js/.jsx/.py/.rs/.go/.md files, store them in the codebase_index table. Call this on the FIRST turn for a new project, or after large refactors. Subsequent turns get an index summary injected into context (codebase awareness). Also enables symbol search via search_code. Returns { indexedFiles, indexedSymbols, durationMs }.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        required: [],
      }),
      execute: async () => {
        const deps = toolDeps;
        if (!deps?.db) return { ok: false, output: "indexing unavailable (no db in this context)" };
        if (!deps.projectId) return { ok: false, output: "indexing unavailable (no project bound to this session)" };
        const result = reindexProject(deps.db, deps.projectId, root);
        return {
          ok: true,
          output: `indexed ${result.indexedFiles} files, ${result.indexedSymbols} symbols in ${result.durationMs}ms. The index summary is now injected into your context for codebase awareness.`,
        };
      },
    },
    // ── ROUND-44 (R44-a): PROJECT MEMORY ──────────────────────────────────
    // Per-project persistent knowledge (facts/decisions/preferences). The
    // newest memories are auto-injected into the system prompt; these tools
    // save new ones and recall beyond the digest cap. All three live in the
    // base Record so the allow filter above applies to them like every
    // other tool.
    memory_save: {
      description:
        "Persist a durable fact/decision/preference about this project to recall in future sessions. Use for architecture decisions, owner preferences, gotchas — NOT transient state.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The knowledge to remember (one item per call, max 4000 chars)",
          },
          kind: {
            type: "string",
            description: "fact | decision | preference | note (default note)",
            enum: ["fact", "decision", "preference", "note"],
          },
        },
        required: ["content"],
      }),
      execute: async (input) => memorySaveTool(toolDeps, input.content, input.kind),
    },
    memory_recall: {
      description:
        "Search this project's saved memories (durable facts, decisions, preferences) by keyword, or list the newest 12 when no query is given. Content matches rank first.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring to look for in saved memories (omit = newest 12)",
          },
        },
        required: [],
      }),
      execute: async (input) => memoryRecallTool(toolDeps, input.query),
    },
    memory_list: {
      description:
        "List this project's saved memories newest-first (default 20, max 50). Use to browse everything the project remembers.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max memories to return (default 20, cap 50)",
          },
        },
        required: [],
      }),
      execute: async (input) => memoryListTool(toolDeps, input.limit),
    },
  };
  if (allow !== null) {
    for (const name of Object.keys(tools)) {
      if (!allow.has(name)) delete tools[name as keyof typeof tools];
    }
  }
  // ROUND-49 (owner directive: "a setting to turn off this memory
  // functionality"): the memory master switch — when explicitly disabled the
  // memory tools are simply not registered (the model never sees them, so it
  // can neither save new memories nor be fed stale ones through recall; the
  // digest injection lives in runtime.ts prepareTurn under the same switch).
  if (toolDeps?.memoryEnabled === false) {
    delete tools.memory_save;
    delete tools.memory_recall;
    delete tools.memory_list;
  }
  // ── ROUND-36 (ADR-0022): SUB-AGENT DELEGATION ───────────────────────────
  // The parent delegates self-contained subtasks; children run their own
  // sessions concurrently (per-key + total limits) and report back.
  // ROUND-49 (owner directive: sub-agents are "exactly like how the main
  // agent works — the only difference is the separate context and API
  // keys"): children MAY delegate too (nested sub-agents) — the runtime
  // strips delegate_task only at/beyond MAX_DELEGATION_DEPTH so the fan-out
  // can never recurse forever. prepareTurn owns that decision; it passes an
  // allowlist that either permits or forbids delegate_task for this turn.
  const delegateAllowed = allow === null || allow.has("delegate_task");
  if (delegateAllowed && toolDeps && toolDeps.keyring !== undefined && toolDeps.chat !== undefined) {
    const { getOrchestrator } = await import("../agents/orchestrator.js");
    tools.delegate_task = {
      description:
        "Delegate a self-contained subtask to an independent sub-agent that runs with the same project tools and reports back. Make MULTIPLE delegate_task calls in ONE message to run sub-agents in PARALLEL. Each call waits for its sub-agent to finish and returns its final report. Use for parallelizable work: researching several areas at once, reviewing multiple modules, independent implementation tasks. role: planner|researcher|coder|reviewer|tester (default researcher).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The complete, self-contained task for the sub-agent (include ALL context it needs — it cannot see this conversation).",
          },
          role: {
            type: "string",
            description: "planner | researcher | coder | reviewer | tester (default researcher)",
            enum: ["planner", "researcher", "coder", "reviewer", "tester"],
          },
        },
        required: ["task"],
      }),
      execute: async (input) => {
        const task = typeof input.task === "string" ? input.task.trim() : "";
        if (task === "") return { ok: false, output: "task must be a non-empty string" };
        const role: SubRole =
          typeof input.role === "string" && (SUB_ROLES as readonly string[]).includes(input.role)
            ? (input.role as SubRole)
            : "researcher";
        const orchestrator = getOrchestrator();
        const result = await orchestrator.delegateTask(
          {
            db: toolDeps.db,
            keyring: toolDeps.keyring!,
            chat: toolDeps.chat!,
            // ROUND-50 (R50-b): forward the streaming adapter — a streamed
            // parent turn spawns STREAMED children (live raw deltas to the
            // sub-agent panel); sync parents keep the sync fallback.
            ...(toolDeps.chatStream !== undefined ? { chatStream: toolDeps.chatStream } : {}),
          },
          toolDeps.sessionId,
          task,
          role,
          toolDeps.emit,
          // ROUND-48 (R48-e1): forward the live parent turn's abort signal so
          // the child stops between iterations + its approvals deny on abort.
          toolDeps.signal,
        );
        return { ok: result.ok, output: result.output };
      },
    };
  }

  return tools as unknown as ToolSet;
}
