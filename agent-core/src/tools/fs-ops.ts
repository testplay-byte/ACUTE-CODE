/**
 * ROUND-52 (R52-f): the pure filesystem/search TOOL IMPLEMENTATIONS, split
 * out of tools/index.ts so the plugin modules (tools/plugins/*.ts) can import
 * them WITHOUT a module cycle (index.ts imports the registry which imports
 * the plugins). Everything here is verbatim the pre-R52 code — the move is
 * architectural, not semantic; index.ts re-exports the public surface for
 * back-compat (server.ts + the test suites import from "./index.js").
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";
import type { ToolResult } from "./registry.js";

/** Maximum bytes a single read returns (keeps context windows sane). */
const MAX_READ_BYTES = 256 * 1024;
/** ROUND-70 (R70-a): when a read_file window exceeds MAX_READ_BYTES, keep
 * BOTH ends — first ~32KB + last ~32KB with an honest omitted-middle marker
 * (same head+tail policy as run_command: a file's interesting parts are the
 * top AND the bottom, and the model can page the middle with offset/limit). */
const READ_WINDOW_HEAD = 32 * 1024;
const READ_WINDOW_TAIL = 32 * 1024;
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

/* ── ROUND-70 (R70-a): the MODEL-FACING read (line numbers + pagination) ───── */

/** Options for readFileWindow — the read_file TOOL's offset/limit params. */
export interface ReadFileWindowOptions {
  /** 1-based line number to start from (default 1). */
  offset?: number;
  /** Number of lines to return (default: everything from offset, within the
   * content cap). */
  limit?: number;
}

/** cat -n-style prefix: right-aligned 6-width line number + two spaces.
 * The CONTENT after the prefix stays byte-exact — the prefix is metadata the
 * model must strip when building edit_file anchors (the tool description
 * says so). */
function numberLine(n: number, text: string): string {
  return `${String(n).padStart(6)}  ${text}`;
}

/** UTF-8-aware byte prefix of a (giant single) line. */
function byteSliceStart(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  return buf.length <= maxBytes ? text : buf.subarray(0, maxBytes).toString("utf8");
}

/** UTF-8-aware byte suffix of a (giant single) line. */
function byteSliceEnd(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  return buf.length <= maxBytes ? text : buf.subarray(buf.length - maxBytes).toString("utf8");
}

const lineBytes = (text: string): number => Buffer.byteLength(text, "utf8") + 1;

/**
 * readFileWindow — the read_file TOOL implementation (SWE-agent ACI + Claude
 * Code's Read parity):
 *   - output is LINE-NUMBERED (cat -n style) so the model can cite path:line
 *     and page large files instead of re-reading them whole;
 *   - `offset` (1-based start line) + `limit` (line count) window the file;
 *     both validate honestly (offset < 1 / limit < 1 / offset past EOF all
 *     return explicit errors, never silent empty results);
 *   - an EMPTY file resolves to an explicit "File exists but is empty" note;
 *   - the 256KB cap counts CONTENT (pre-prefix); an oversized window keeps
 *     the first ~32KB + the last ~32KB with an honest omitted-middle marker
 *     that points at offset/limit for the middle.
 *
 * The RAW `readFile` above is unchanged for the REST file-viewer route
 * (server.ts /projects/:id/file) — only the read_file TOOL output is
 * line-numbered.
 */
export function readFileWindow(root: string, relative: string, options?: ReadFileWindowOptions): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  const offset = options?.offset;
  const limit = options?.limit;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)) {
    return { ok: false, output: `read_file 'offset' must be an integer ≥ 1 (got ${JSON.stringify(offset)})` };
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    return { ok: false, output: `read_file 'limit' must be an integer ≥ 1 (got ${JSON.stringify(limit)})` };
  }
  try {
    const stats = statSync(resolved.abs);
    if (stats.isDirectory()) return { ok: false, output: `'${relative}' is a directory — use list_dir` };
    const buffer = readFileSync(resolved.abs);
    if (buffer.length === 0) {
      // D4 honesty: an empty result is ambiguous (did the read fail?).
      return { ok: true, output: `File exists but is empty (0 bytes): '${relative}'` };
    }
    const content = buffer.toString("utf8");
    const lines = content.split("\n");
    // A trailing newline does not create a phantom final line (cat -n
    // semantics: "a\nb\n" is 2 lines). \r stays attached to its line so the
    // content after the prefix stays byte-exact (CRLF-safe edit anchors).
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;
    const startLine = offset ?? 1;
    if (startLine > totalLines) {
      return {
        ok: false,
        output: `offset ${startLine} is beyond end of file ('${relative}' has ${totalLines} line${totalLines === 1 ? "" : "s"})`,
      };
    }
    const endLine = limit !== undefined ? Math.min(startLine + limit - 1, totalLines) : totalLines;
    const windowLines = lines.slice(startLine - 1, endLine);
    const numbered = (from: number, ls: string[]): string =>
      ls.map((l, i) => numberLine(from + i, l)).join("\n");
    const windowBytes = Buffer.byteLength(windowLines.join("\n"), "utf8");

    if (windowBytes <= MAX_READ_BYTES) {
      const body = numbered(startLine, windowLines);
      // A requested limit that ran past EOF says so — the model asked for N
      // lines and got fewer; never let that look like a partial failure.
      if (limit !== undefined && startLine + limit - 1 > totalLines) {
        return {
          ok: true,
          output: `${body}\n[end of file: returned lines ${startLine}-${endLine} of ${totalLines}]`,
        };
      }
      return { ok: true, output: body };
    }

    // Oversized window: head + tail with an honest marker (never head-only —
    // the same R70-a policy as run_command's output cap).
    if (windowLines.length === 1) {
      // Degenerate case: ONE line bigger than the whole cap (a minified
      // asset / data blob). Byte-slice the line itself into head + tail —
      // both numbered with the line's true number.
      const line = windowLines[0];
      const headText = numberLine(startLine, byteSliceStart(line, READ_WINDOW_HEAD));
      const tailText = numberLine(startLine, byteSliceEnd(line, READ_WINDOW_TAIL));
      const omittedOneLine = Math.max(windowBytes - READ_WINDOW_HEAD - READ_WINDOW_TAIL, 0);
      const markerOneLine =
        `…[file truncated: ${omittedOneLine} bytes omitted from the middle of line ${startLine} — ` +
        `the file is one long line]…`;
      return { ok: true, output: `${headText}\n${markerOneLine}\n${tailText}` };
    }
    const head: Array<{ n: number; text: string }> = [];
    let used = 0;
    let i = 0;
    for (; i < windowLines.length; i++) {
      const bytes = lineBytes(windowLines[i]);
      if (used + bytes > READ_WINDOW_HEAD) break;
      head.push({ n: startLine + i, text: windowLines[i] });
      used += bytes;
    }
    if (head.length === 0 && windowLines.length > 0) {
      // A single line bigger than the whole head budget: byte-slice it.
      head.push({ n: startLine, text: byteSliceStart(windowLines[0], READ_WINDOW_HEAD) });
      i = 1;
    }
    const tail: Array<{ n: number; text: string }> = [];
    used = 0;
    let j = windowLines.length - 1;
    for (; j >= i; j--) {
      const bytes = lineBytes(windowLines[j]);
      if (used + bytes > READ_WINDOW_TAIL) break;
      tail.unshift({ n: startLine + j, text: windowLines[j] });
      used += bytes;
    }
    if (tail.length === 0 && j >= i) {
      // The last reachable line is itself bigger than the tail budget.
      tail.unshift({ n: startLine + j, text: byteSliceEnd(windowLines[j], READ_WINDOW_TAIL) });
      j--;
    }
    const keptBytes =
      head.reduce((sum, l) => sum + lineBytes(l.text), 0) + tail.reduce((sum, l) => sum + lineBytes(l.text), 0);
    const omitted = Math.max(windowBytes - keptBytes, 0);
    const headText = head.map((l) => numberLine(l.n, l.text)).join("\n");
    const tailText = tail.length > 0 ? tail.map((l) => numberLine(l.n, l.text)).join("\n") : "";
    const lastHeadLine = head.length > 0 ? head[head.length - 1].n : startLine - 1;
    const firstTailLine = tail.length > 0 ? tail[0].n : lastHeadLine + 1;
    const marker =
      `…[file truncated: ${omitted} bytes omitted between line ${lastHeadLine} and line ${firstTailLine} — ` +
      `use offset/limit to page through the middle]…`;
    return {
      ok: true,
      output: tailText !== "" ? `${headText}\n${marker}\n${tailText}` : `${headText}\n${marker}`,
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
