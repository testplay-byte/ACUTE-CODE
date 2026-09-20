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
/** ROUND-96 (R96-C): the WHOLE-FILE-FIRST budget — the default read_file
 * (no offset/limit) returns the entire file when its content fits this,
 * with no marker and no paging language. The owner's bug class: a modest
 * HTML file was read in needless PARTS. 48KB ≈ 12k tokens — safe for the
 * free 32–64k-context models (research note (a): the 256KB MAX_READ_BYTES
 * ceiling can blow such a window; it stays as the cap for EXPLICIT
 * offset/limit windows, i.e. targeted re-reads). */
export const READ_WHOLE_BUDGET_BYTES = 48 * 1024;
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

/** The degenerate single-line slice (one line bigger than the budget): the
 * line itself byte-sliced head+tail with the honest no-continuation marker.
 * Shared by the explicit-window oversized path and the ROUND-96 default-read
 * budget path (R71-e2 D1 semantics: the marker names real recovery tools
 * instead of pretending offset/limit works). */
function readSingleLineSlice(startLine: number, line: string, totalLines: number): ToolResult {
  const headText = numberLine(startLine, byteSliceStart(line, READ_WINDOW_HEAD));
  const tailText = numberLine(startLine, byteSliceEnd(line, READ_WINDOW_TAIL));
  const lineTotalBytes = Buffer.byteLength(line, "utf8");
  const omittedOneLine = Math.max(lineTotalBytes - READ_WINDOW_HEAD - READ_WINDOW_TAIL, 0);
  const markerOneLine =
    `…[file truncated: ${omittedOneLine} bytes omitted from the middle of line ${startLine} of ${totalLines} total ` +
    `(${lineTotalBytes}-byte single line: first ${READ_WINDOW_HEAD} + last ${READ_WINDOW_TAIL} bytes kept) — ` +
    `no continuation call can reach this middle: offset/limit pages whole LINES and this is one line; ` +
    `use search_code (content match) or run_command (grep) to inspect it]…`;
  return { ok: true, output: `${headText}\n${markerOneLine}\n${tailText}` };
}

/**
 * readFileWindow — the read_file TOOL implementation (SWE-agent ACI + Claude
 * Code's Read parity):
 *   - output is LINE-NUMBERED (cat -n style) so the model can cite path:line
 *     and page large files instead of re-reading them whole;
 *   - ROUND-96 (R96-C) WHOLE-FILE-FIRST: the DEFAULT read (no offset/limit)
 *     returns the ENTIRE file when it fits READ_WHOLE_BUDGET_BYTES (~48KB) —
 *     no marker, no paging language ("do not split modest files into parts",
 *     the owner's HTML-file bug class). Over the budget it returns PAGE 1 (the
 *     first lines that fit) + the honest marker with the file's TOTAL line
 *     count and the EXACT next call ("use offset=N to continue") — Claude
 *     Code's PARTIAL-notice shape; the model pages only from the marker;
 *   - `offset` (1-based start line) + `limit` (line count) window the file;
 *     both validate honestly (offset < 1 / limit < 1 / offset past EOF all
 *     return explicit errors, never silent empty results). An explicit window
 *     keeps the R70-a machinery: ≤256KB returns the whole window, over that
 *     keeps the first ~32KB + the last ~32KB with an honest omitted-middle
 *     marker;
 *   - an EMPTY file resolves to an explicit "File exists but is empty" note;
 *   - the degenerate single-line cap (one line bigger than the whole budget)
 *     byte-slices the line and says so HONESTLY: line-based paging cannot
 *     reach the omitted bytes, and the marker names real recovery tools
 *     (search_code / run_command) instead of pretending offset/limit works.
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

    // ROUND-96 (R96-C): the DEFAULT read (no offset AND no limit) is
    // WHOLE-FILE-FIRST — the owner's bug class was a modest HTML file read
    // in needless parts. Under READ_WHOLE_BUDGET_BYTES the ENTIRE file
    // returns in ONE call (no marker, no paging language); over it, PAGE 1
    // (the first lines that fit the budget) + the honest marker with the
    // total line count and the EXACT next call. Explicit offset/limit
    // windows (targeted re-reads / huge-file paging) keep the R70-a
    // machinery below.
    if (offset === undefined && limit === undefined) {
      if (windowBytes <= READ_WHOLE_BUDGET_BYTES) {
        return { ok: true, output: numbered(1, windowLines) };
      }
      if (windowLines.length === 1) {
        // One line bigger than the whole-file budget: the shared degenerate
        // byte-slice (head 32KB + tail 32KB + the honest no-continuation
        // marker).
        return readSingleLineSlice(1, windowLines[0], totalLines);
      }
      // Page 1: the first lines that fit READ_WHOLE_BUDGET_BYTES.
      const page: Array<{ n: number; text: string }> = [];
      let usedPage = 0;
      let pi = 0;
      for (; pi < windowLines.length; pi++) {
        const bytes = lineBytes(windowLines[pi]);
        if (usedPage + bytes > READ_WHOLE_BUDGET_BYTES) break;
        page.push({ n: 1 + pi, text: windowLines[pi] });
        usedPage += bytes;
      }
      if (page.length === 0) {
        // The first line alone exceeds the budget (but is not the only
        // line): byte-slice the first line like the head-budget path does.
        return readSingleLineSlice(1, windowLines[0], totalLines);
      }
      const lastPageLine = page[page.length - 1].n;
      const omittedBytes = Math.max(windowBytes - usedPage, 0);
      const marker =
        `…[file truncated: showing lines 1-${lastPageLine} of ${totalLines} total ` +
        `(${omittedBytes} bytes omitted after line ${lastPageLine}) — use offset=${lastPageLine + 1} to continue]…`;
      return { ok: true, output: `${numbered(1, page.map((p) => p.text))}\n${marker}` };
    }

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

    // Oversized EXPLICIT window: head + tail with an honest marker (never
    // head-only — the same R70-a policy as run_command's output cap).
    if (windowLines.length === 1) {
      // Degenerate case: ONE line bigger than the whole cap (a minified
      // asset / data blob). Byte-slice the line itself into head + tail —
      // both numbered with the line's true number. R71-e2 D1: the marker
      // carries the total line count + byte semantics AND says honestly
      // that no continuation call exists (offset/limit pages whole LINES;
      // there is only one line) — the recovery path is a different tool.
      return readSingleLineSlice(startLine, windowLines[0], totalLines);
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
    // R71-e2 D1 (kilocode's exact-continuation): the marker carries the
    // byte count, the two boundary lines, the file's TOTAL line count, and
    // the EXACT next call — offset = the first OMITTED line (the line right
    // after the kept head, the same "use offset=1891 to continue" semantic
    // kilocode proved out). Paging from there walks the middle; when the
    // model reaches firstTailLine it already has the tail in hand.
    const continueFrom = lastHeadLine + 1;
    const marker =
      `…[file truncated: ${omitted} bytes omitted between line ${lastHeadLine} and line ${firstTailLine} ` +
      `of ${totalLines} total — use offset=${continueFrom} to continue]…`;
    return {
      ok: true,
      output: tailText !== "" ? `${headText}\n${marker}\n${tailText}` : `${headText}\n${marker}`,
    };
  } catch {
    return { ok: false, output: `cannot read '${relative}': no such file` };
  }
}

/** write_file — create or overwrite (parent folders auto-created).
 * ROUND-115 convention (docs/design-language/android/README.md, the pinned
 * table): the project's exchange folders are <root>/attachments/ (UPLOADS —
 * the chat upload route creates it, routes/attachments.ts) and
 * <root>/downloads/ (DOWNLOADS — created on demand by the desktop browser's
 * download path; until that path lands, THIS recursive mkdir is the only
 * code that mints it, e.g. an agent saving a fetched file to downloads/x). */
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

/* ── ROUND-96 (R96-C): the EDIT ENGINE — exact-first, one variant rung, ────
 * atomic batches. The owner's words: "It should be easily able to target the
 * changes it needs to make in the files… It will try its variants." The
 * contract (research §2.2 + §6.2): EXACT match first (Claude Code's hard
 * doctrine), then exactly ONE fallback rung — whitespace-normalized matching
 * (Aider's useful rung; its fuzzy rungs are deliberately NOT ported — they
 * corrupt code and destroy auditability). Ambiguity never fuzzes: >1 match
 * fails with the existing longer-anchor diagnostics. */

/** One edit in a batch. replaceAll is per-op (Claude Code MultiEdit parity). */
export interface EditOp {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

/** The single-edit options (the oldString/newString shorthand). */
export interface EditFileOptions {
  replaceAll?: boolean;
}

/** Collapse every run of whitespace to a single space, keeping a map from
 * each normalized character to its ORIGINAL index so a normalized match can
 * be projected back onto the exact original span (the rung must replace the
 * bytes that are really there, not the normalized idealization). */
function normalizeWhitespaceWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      norm += " ";
      map.push(i);
      i = j;
    } else {
      norm += text[i];
      map.push(i);
      i++;
    }
  }
  return { norm, map };
}

/** English ordinal for the batch failure report (1st, 2nd, 3rd, 11th…). */
function editOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Structured anchor-failure reasons — the callers compose the final
 * model-facing text (the R71 suites pin the single-edit formats byte-exactly,
 * and the batch form needs its own index-prefixed composition). */
type EditOpError =
  | { kind: "empty-anchor" }
  | { kind: "not-found" }
  | { kind: "ambiguous"; occurrences: number; normalized: boolean };

/** Apply ONE op to content — exact rung first, whitespace-normalized rung
 * second (only when the exact anchor is absent), ambiguity fails. Returns the
 * new content + a report of what happened, or a structured anchor error. */
function applyEditOp(
  content: string,
  op: EditOp,
): { ok: true; content: string; count: number; rung: "exact" | "whitespace-normalized" } | { ok: false; error: EditOpError } {
  const { oldString, newString } = op;
  if (oldString === "") {
    return { ok: false, error: { kind: "empty-anchor" } };
  }
  // Rung 1 — EXACT (the doctrine: read-first + byte-exact anchors).
  const first = content.indexOf(oldString);
  if (first !== -1) {
    const last = content.lastIndexOf(oldString);
    if (first !== last && op.replaceAll !== true) {
      return {
        ok: false,
        error: { kind: "ambiguous", occurrences: content.split(oldString).length - 1, normalized: false },
      };
    }
    const count = op.replaceAll === true ? content.split(oldString).length - 1 : 1;
    return { ok: true, content: content.split(oldString).join(newString), count, rung: "exact" };
  }
  // Rung 2 — whitespace-normalized (ONE variant, honestly reported). Runs of
  // whitespace in BOTH the anchor and the content collapse to a single space
  // before searching; the matched ORIGINAL span is replaced.
  const anchorNorm = normalizeWhitespaceWithMap(oldString).norm;
  const { norm: contentNorm, map } = normalizeWhitespaceWithMap(content);
  const normFirst = contentNorm.indexOf(anchorNorm);
  if (normFirst === -1) {
    return { ok: false, error: { kind: "not-found" } };
  }
  const normLast = contentNorm.lastIndexOf(anchorNorm);
  if (normFirst !== normLast && op.replaceAll !== true) {
    return {
      ok: false,
      error: { kind: "ambiguous", occurrences: countOccurrences(contentNorm, anchorNorm), normalized: true },
    };
  }
  /** Project one normalized span onto the original content. */
  const spanOf = (at: number): { start: number; end: number } => ({
    start: map[at],
    // The span ends where the NEXT normalized character starts — so a
    // trailing collapsed run is replaced in full (and a non-whitespace end
    // stops right after its own character).
    end: at + anchorNorm.length < map.length ? map[at + anchorNorm.length] : content.length,
  });
  if (op.replaceAll === true) {
    const spans: Array<{ start: number; end: number }> = [];
    let at = contentNorm.indexOf(anchorNorm);
    while (at !== -1) {
      spans.push(spanOf(at));
      at = contentNorm.indexOf(anchorNorm, at + anchorNorm.length);
    }
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += content.slice(cursor, span.start) + newString;
      cursor = span.end;
    }
    out += content.slice(cursor);
    return { ok: true, content: out, count: spans.length, rung: "whitespace-normalized" };
  }
  const span = spanOf(normFirst);
  return {
    ok: true,
    content: content.slice(0, span.start) + newString + content.slice(span.end),
    count: 1,
    rung: "whitespace-normalized",
  };
}

/** The single-edit diagnostic for a structured anchor error (the R71 pins:
 * "edit failed: oldString not found in 'x'" / "edit failed: oldString matches
 * N times in 'x' — provide a longer unique anchor" — kept byte-exact for the
 * not-found case, extended with the replaceAll hint for the ambiguous one). */
function singleEditError(error: EditOpError, relative: string): string {
  switch (error.kind) {
    case "empty-anchor":
      return `edit failed: oldString is empty — copy the exact text to replace (read_file the region first)`;
    case "not-found":
      return `edit failed: oldString not found in '${relative}'`;
    case "ambiguous":
      return error.normalized
        ? `edit failed: oldString matches ${error.occurrences} times after whitespace normalization in '${relative}' — provide a longer unique anchor`
        : `edit failed: oldString matches ${error.occurrences} times in '${relative}' — provide a longer unique anchor (or set replaceAll: true)`;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** The compact model-facing confirmation (no diff body — the UI renders
 * diffs from the recorded snapshots; the model context stays lean):
 * "Edited <path>: 2 replacements, +12 −3 lines (whitespace-normalized rung on #2)". */
function editConfirmation(
  relPath: string,
  replacements: number,
  linesAdded: number,
  linesRemoved: number,
  rungOps: number[],
): string {
  const rungNote =
    rungOps.length > 0 ? ` (whitespace-normalized rung on ${rungOps.map((n) => `#${n}`).join(", ")})` : "";
  return `Edited '${relPath}': ${replacements} replacement${replacements === 1 ? "" : "s"}, +${linesAdded} −${linesRemoved} lines${rungNote}`;
}

/** Count the newline-separated LINES a string spans (1 for an inline fragment). */
const lineCount = (text: string): number => text.split("\n").length;

/** The hard batch cap — a model past 32 anchors in one call has lost the
 * thread; the honest error asks for a split instead of a slow mega-apply. */
export const MAX_EDIT_OPS = 32;

/**
 * editFile — the SINGLE-edit shorthand (exact-first doctrine + the
 * whitespace-normalized fallback rung + optional replaceAll). Kept as its own
 * export for every historical caller; editFileMulti below is the batch form.
 */
export function editFile(
  root: string,
  relative: string,
  oldString: string,
  newString: string,
  options?: EditFileOptions,
): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  let content: string;
  try {
    content = readFileSync(resolved.abs, "utf8");
  } catch {
    return { ok: false, output: `cannot edit '${relative}': no such file` };
  }
  const applied = applyEditOp(content, { oldString, newString, replaceAll: options?.replaceAll });
  if (!applied.ok) {
    // The exact historic diagnostics (pinned by the R71 suites — the streak
    // machinery keys on the "edit failed:" prefix).
    return { ok: false, output: singleEditError(applied.error, relative) };
  }
  writeFileSync(resolved.abs, applied.content, "utf8");
  const linesAdded = lineCount(newString);
  const linesRemoved = lineCount(oldString);
  return {
    ok: true,
    output: editConfirmation(toRelative(root, resolved.abs), applied.count, linesAdded, linesRemoved, applied.rung === "whitespace-normalized" ? [1] : []),
  };
}

/**
 * editFileMulti — the ATOMIC batch (R96-C): every anchor is validated IN
 * SEQUENCE against the evolving content (each op applies to the result of
 * the previous), and ONE write lands only when ALL of them match. Any
 * failure reports WHICH index failed and leaves the file UNTOUCHED — a
 * partially-applied batch is unauditable and the snapshot/revert story keys
 * on whole-file states (research note (b)).
 */
export function editFileMulti(root: string, relative: string, edits: EditOp[]): ToolResult {
  const resolved = resolveInsideRoot(root, relative);
  if ("error" in resolved) return { ok: false, output: resolved.error };
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, output: `cannot edit '${relative}': 'edits' must be a non-empty array of {oldString, newString}` };
  }
  if (edits.length > MAX_EDIT_OPS) {
    return {
      ok: false,
      output: `cannot edit '${relative}': ${edits.length} edits exceed the ${MAX_EDIT_OPS}-edit cap — split the batch`,
    };
  }
  for (let k = 0; k < edits.length; k++) {
    const op = edits[k];
    if (typeof op !== "object" || op === null || typeof op.oldString !== "string" || typeof op.newString !== "string") {
      return {
        ok: false,
        output: `cannot edit '${relative}': edits[${k}] must be an {oldString, newString} object with string values`,
      };
    }
  }
  let content: string;
  try {
    content = readFileSync(resolved.abs, "utf8");
  } catch {
    return { ok: false, output: `cannot edit '${relative}': no such file` };
  }
  let working = content;
  let replacements = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const rungOps: number[] = [];
  for (let k = 0; k < edits.length; k++) {
    const op: EditOp = {
      oldString: edits[k].oldString,
      newString: edits[k].newString,
      ...(edits[k].replaceAll === true ? { replaceAll: true } : {}),
    };
    const applied = applyEditOp(working, op);
    if (!applied.ok) {
      const others = edits.length - 1;
      const reason =
        applied.error.kind === "empty-anchor"
          ? "oldString is empty — copy the exact text to replace"
          : applied.error.kind === "not-found"
            ? `oldString not found in '${relative}'`
            : applied.error.normalized
              ? `oldString matches ${applied.error.occurrences} times after whitespace normalization in '${relative}' — provide a longer unique anchor`
              : `oldString matches ${applied.error.occurrences} times in '${relative}' — provide a longer unique anchor (or set replaceAll: true)`;
      return {
        ok: false,
        output:
          `edit failed: edits[${k}] (${editOrdinal(k + 1)} of ${edits.length}) ${reason} — ` +
          `NO changes were applied (the file is untouched); the other ${others} edit${others === 1 ? "" : "s"} were not applied either. ` +
          `Re-read the file, fix that one anchor, and re-send the whole batch.`,
      };
    }
    working = applied.content;
    replacements += applied.count;
    linesAdded += lineCount(op.newString);
    linesRemoved += lineCount(op.oldString);
    if (applied.rung === "whitespace-normalized") rungOps.push(k + 1);
  }
  writeFileSync(resolved.abs, working, "utf8");
  return {
    ok: true,
    output: editConfirmation(toRelative(root, resolved.abs), replacements, linesAdded, linesRemoved, rungOps),
  };
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

/* ── ROUND-96 (R96-C): the SMART SEARCH WALK ───────────────────────────────
 * The owner: "If it needs to search something in the project, it should
 * utilize smarter techniques rather than checking each and every single one
 * of the files." ripgrep semantics, hand-rolled (no new deps):
 *   - .gitignore respected DURING the walk (per-directory stacking, anchored
 *     vs basename rules, trailing-slash dir rules, `!` re-includes;
 *     node_modules/.git/dist/build are ALWAYS skipped regardless);
 *   - binary files (a NUL byte in the first 8KB) and files over 2MB skipped;
 *   - per-file grouped results with per-file truncation notes and an honest
 *     totals line that flags truncation. */

/** A tiny glob → RegExp compiler: `**` crosses directory separators, `*` and
 * `?` stay within one segment, everything else is literal (no character
 * classes — the minimal matcher the tools need; file_glob and search_files
 * patterns and the .gitignore rules all share it). */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        let j = i + 2;
        while (glob[j] === "*") j++;
        if (glob[j] === "/") {
          // "**/" — zero or more directory levels.
          re += "(?:.*/)?";
          i = j;
        } else {
          // "**" — anything, including separators.
          re += ".*";
          i = j - 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

/** One parsed .gitignore line. `sourceRel` is the .gitignore's directory as
 * a root-relative POSIX path ("" = the project root); the rule only applies
 * to paths inside it. */
interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  /** Contains a (non-trailing) slash → match against the path RELATIVE to
   * the .gitignore's directory; otherwise match against the basename at any
   * depth (git semantics). */
  anchored: boolean;
  sourceRel: string;
  re: RegExp;
}

function parseGitignoreRules(text: string, sourceRel: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === "") continue;
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    } else if (line.includes("/")) {
      anchored = true;
    }
    rules.push({ negated, dirOnly, anchored, sourceRel, re: globToRegExp(line) });
  }
  return rules;
}

/** Last matching rule wins (git semantics); dir-only rules are resolved when
 * the DIRECTORY itself is visited (an ignored dir is pruned, so its contents
 * are never reached — no per-file ancestor walk needed). */
function ignoredByRules(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    let rel: string;
    if (rule.sourceRel === "") rel = relPath;
    else if (relPath === rule.sourceRel) continue; // a dir's own .gitignore never ignores the dir itself
    else if (relPath.startsWith(`${rule.sourceRel}/`)) rel = relPath.slice(rule.sourceRel.length + 1);
    else continue; // outside this rule's directory
    if (rel === "") continue;
    if (rule.dirOnly && !isDir) continue;
    const hit = rule.anchored ? rule.re.test(rel) : rule.re.test(rel.split("/").pop() ?? rel);
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

function loadDirIgnoreRules(absDir: string, relDir: string): IgnoreRule[] {
  try {
    const text = readFileSync(join(absDir, ".gitignore"), "utf8");
    return parseGitignoreRules(text, relDir);
  } catch {
    return []; // no .gitignore here — the common case
  }
}

/** Walk the project from `baseAbs` (inside `root`), yielding every file that
 * survives the ignore rules. `visit` returns false to STOP the whole walk
 * (the hard caps). Deterministic (entries sorted per directory). */
function walkProjectFiles(
  root: string,
  baseAbs: string,
  baseRel: string,
  visit: (absPath: string, relPath: string, size: number, mtimeMs: number) => boolean,
): void {
  // A subdir search still honors the ancestors' .gitignore files — load the
  // root→base chain first (the walk never visits those dirs itself). The
  // BASE's own .gitignore loads when the walk enters it, so the chain stops
  // one level above.
  const chain: IgnoreRule[] = [];
  if (baseRel !== "") {
    chain.push(...loadDirIgnoreRules(root, ""));
    const segs = baseRel.split("/");
    let abs = root;
    let rel = "";
    for (const seg of segs.slice(0, -1)) {
      abs = join(abs, seg);
      rel = rel === "" ? seg : `${rel}/${seg}`;
      chain.push(...loadDirIgnoreRules(abs, rel));
    }
  }
  const walk = (absDir: string, relDir: string, depth: number, rules: IgnoreRule[]): boolean => {
    if (depth > MAX_DEPTH) return true;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return true;
    }
    entries.sort();
    const local = loadDirIgnoreRules(absDir, relDir);
    const allRules = local.length > 0 ? [...rules, ...local] : rules;
    for (const name of entries.slice(0, MAX_ENTRIES)) {
      // ALWAYS-skipped directories — a `!` re-include cannot resurrect them.
      if (IGNORED_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".github") continue;
      const relPath = relDir === "" ? name : `${relDir}/${name}`;
      let isDir = false;
      let size = 0;
      let mtimeMs = 0;
      try {
        const stats = statSync(join(absDir, name));
        isDir = stats.isDirectory();
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        continue; // unreadable entry — skip
      }
      if (ignoredByRules(relPath, isDir, allRules)) continue;
      if (isDir) {
        if (!walk(join(absDir, name), relPath, depth + 1, allRules)) return false;
      } else if (!visit(join(absDir, name), relPath, size, mtimeMs)) {
        return false;
      }
    }
    return true;
  };
  walk(baseAbs, baseRel, 0, chain);
}

/** search_files — find files by NAME (R96-C: + glob patterns, mtime-desc
 * ordering, 100-result cap with an honest truncation flag; the substring
 * query stays for back-compat). */
export interface SearchFilesOptions {
  /** A glob like the TS form — double-star crosses directories, single star
 * stays within one segment. */
  pattern?: string;
}

/** The search_files display cap (Claude Code Glob parity: 100 files). */
export const SEARCH_FILES_CAP = 100;
/** The hard counting cap — beyond this the walk stops and says so. */
const SEARCH_FILES_HARD_CAP = 1000;

export function searchFiles(root: string, query: string, dir?: string, options?: SearchFilesOptions): ToolResult {
  const glob = options?.pattern !== undefined ? options.pattern.trim() : "";
  const needle = query.trim().toLowerCase();
  if (glob !== "" && needle !== "") {
    return { ok: false, output: "search_files: pass EITHER query (substring) or pattern (glob) — not both" };
  }
  if (glob === "" && needle === "") {
    return { ok: false, output: "search_files needs a non-empty 'query' (substring) or 'pattern' (glob like '**/*.ts')" };
  }
  const base = dir !== undefined && dir.trim() !== "" ? resolveInsideRoot(root, dir) : ({ abs: root } as const);
  if ("error" in base) return { ok: false, output: base.error };
  const baseRel = base.abs === root ? "" : toRelative(root, base.abs);
  const globRe = glob !== "" ? globToRegExp(glob.replace(/^\.\//, ""), true) : null;
  const hits: Array<{ relPath: string; mtimeMs: number }> = [];
  let truncatedHard = false;
  walkProjectFiles(root, base.abs, baseRel, (_absPath, relPath, _size, mtimeMs) => {
    const hit = globRe !== null ? globRe.test(relPath) : relPath.toLowerCase().includes(needle);
    if (!hit) return true;
    if (hits.length >= SEARCH_FILES_HARD_CAP) {
      truncatedHard = true;
      return false;
    }
    hits.push({ relPath, mtimeMs });
    return true;
  });
  if (hits.length === 0) {
    return {
      ok: true,
      output: glob !== "" ? `no files matching pattern '${glob}'` : `no paths matching '${query}'`,
    };
  }
  // Newest first (Claude Code Glob) — the file the agent just touched is the
  // one it most likely wants next.
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const shown = hits.slice(0, SEARCH_FILES_CAP);
  const hidden = hits.length - shown.length;
  const label = glob !== "" ? `pattern '${glob}'` : `'${query}'`;
  const header =
    `${hits.length} file${hits.length === 1 ? "" : "s"} matching ${label} (newest first)` +
    (hidden > 0 || truncatedHard ? ` — truncated${hidden > 0 ? `: showing ${shown.length} of ${hits.length}` : ""}` : "");
  const lines = shown.map((h) => h.relPath);
  if (hidden > 0) lines.push(`…${hidden} more not shown — narrow the pattern`);
  if (truncatedHard) lines.push(`…stopped counting at ${SEARCH_FILES_HARD_CAP} — narrow the search`);
  return { ok: true, output: `${header}\n${lines.join("\n")}` };
}

/* ── search_code — ripgrep-style content search ─────────────────────────── */

export type SearchOutputMode = "content" | "files_with_matches" | "count";

export interface SearchCodeOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fileGlob?: string;
  maxResults?: number;
  /** R96-C: 'content' (default) | 'files_with_matches' | 'count'. */
  outputMode?: SearchOutputMode;
  /** R96-C: lines of context before/after each match in content mode (0-8). */
  context?: number;
  /** R96-C: treat the query as a regular expression (default: literal
   * substring; the legacy '/pattern/' inline form still works). */
  regex?: boolean;
}

/** Files over this size are skipped (2MB — generated blobs/minified assets). */
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A NUL byte in the first 8KB marks a file binary. */
const SEARCH_BINARY_PROBE_BYTES = 8 * 1024;
/** Hard caps: stop the walk and say so (never scan forever on huge trees). */
const SEARCH_HARD_MATCH_CAP = 2000;
const SEARCH_HARD_FILE_CAP = 500;
/** Per-file display cap in content mode — the "…N more matches in this file"
 * truncation note. */
const SEARCH_PER_FILE_DISPLAY = 20;
/** File rows listed in files_with_matches / count modes. */
const SEARCH_FILE_LIST_CAP = 100;
/** context is clamped to 0-8. */
const SEARCH_CONTEXT_MAX = 8;
/** A single result line is clipped to this length. */
const SEARCH_LINE_CLIP = 240;

function clipSearchLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SEARCH_LINE_CLIP ? `${trimmed.slice(0, SEARCH_LINE_CLIP)}…` : trimmed;
}

/** file_glob: a pattern WITHOUT a slash matches the basename at any depth
 * (the historical behavior — the '*.ts' form hits every directory); a
 * pattern WITH a slash matches the full relative path (the 'src' +
 * double-star + '.ts' form, or a leading double-star). */
function compileFileGlob(glob: string): (relPath: string) => boolean {
  const cleaned = glob.replace(/^\.\//, "");
  const re = globToRegExp(cleaned, true);
  if (cleaned.includes("/")) {
    return (relPath: string): boolean => re.test(relPath);
  }
  return (relPath: string): boolean => re.test(relPath.split("/").pop() ?? relPath);
}

/** ripgrep -C style context block: match lines render as `path:N: text`,
 * context lines as `path-N- text`, non-adjacent groups separated by `--`. */
function renderContextBlock(
  relPath: string,
  lines: string[],
  matchLines: Array<{ line: number; text: string }>,
  context: number,
): string[] {
  const matchSet = new Set(matchLines.map((m) => m.line));
  const spans: Array<[number, number]> = [];
  for (const m of matchLines) {
    const from = Math.max(1, m.line - context);
    const to = Math.min(lines.length, m.line + context);
    const last = spans[spans.length - 1];
    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      spans.push([from, to]);
    }
  }
  const out: string[] = [];
  for (const [from, to] of spans) {
    if (out.length > 0) out.push("--");
    for (let n = from; n <= to; n++) {
      const isMatch = matchSet.has(n);
      out.push(`${relPath}${isMatch ? ":" : "-"}${n}${isMatch ? ": " : "- "}${clipSearchLine(lines[n - 1])}`);
    }
  }
  return out;
}

interface SearchFileResult {
  relPath: string;
  totalInFile: number;
  matchLines: Array<{ line: number; text: string }>;
  contextBlock: string[] | null;
}

export function searchCode(root: string, query: string, dir?: string, options?: SearchCodeOptions): ToolResult {
  const needle = query.trim();
  if (needle === "") return { ok: false, output: "search_code needs a non-empty 'query'" };
  // regex: true is first-class; the legacy '/pattern/' inline form still works
  // when regex is not explicitly set (back-compat).
  const legacyRegex = needle.startsWith("/") && needle.endsWith("/") && needle.length > 2;
  const useRegex = options?.regex === true || legacyRegex;
  let pattern: string;
  if (useRegex) {
    pattern = options?.regex === true ? needle : needle.slice(1, -1);
  } else {
    pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (options?.wholeWord) pattern = `\\b${pattern}\\b`;
  }
  const flags = options?.caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    return {
      ok: false,
      output: `invalid regex: ${needle}${error instanceof Error ? ` (${error.message})` : ""}`,
    };
  }
  const outputMode: SearchOutputMode =
    options?.outputMode === "files_with_matches" || options?.outputMode === "count"
      ? options.outputMode
      : "content";
  const context = Math.max(0, Math.min(SEARCH_CONTEXT_MAX, Math.floor(options?.context ?? 0)));
  const maxResults =
    options?.maxResults !== undefined && options.maxResults > 0
      ? Math.min(200, Math.floor(options.maxResults))
      : 50;
  const globMatcher =
    options?.fileGlob !== undefined && options.fileGlob.trim() !== ""
      ? compileFileGlob(options.fileGlob.trim())
      : null;
  const base = dir !== undefined && dir.trim() !== "" ? resolveInsideRoot(root, dir) : ({ abs: root } as const);
  if ("error" in base) return { ok: false, output: base.error };
  const baseRel = base.abs === root ? "" : toRelative(root, base.abs);

  const files: SearchFileResult[] = [];
  let totalMatches = 0;
  let matchedFileCount = 0;
  let truncated = false;
  let contentBudget = outputMode === "content" ? maxResults : 0;

  walkProjectFiles(root, base.abs, baseRel, (absPath, relPath, size) => {
    if (globMatcher !== null && !globMatcher(relPath)) return true;
    if (size > SEARCH_MAX_FILE_BYTES) return true;
    if (files.length >= SEARCH_HARD_FILE_CAP) {
      truncated = true;
      return false;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(absPath);
    } catch {
      return true;
    }
    if (buf.subarray(0, SEARCH_BINARY_PROBE_BYTES).includes(0)) return true; // binary
    const lines = buf.toString("utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const store = outputMode === "content" && contentBudget > 0;
    const storeCap = Math.min(SEARCH_PER_FILE_DISPLAY, contentBudget);
    const matchLines: Array<{ line: number; text: string }> = [];
    let totalInFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;
      totalMatches++;
      totalInFile++;
      if (totalMatches >= SEARCH_HARD_MATCH_CAP) {
        truncated = true;
        return false;
      }
      if (store && matchLines.length < storeCap) matchLines.push({ line: i + 1, text: lines[i] });
    }
    if (totalInFile === 0) return true;
    matchedFileCount++;
    if (outputMode === "content") {
      if (contentBudget <= 0) {
        // Counted for the honest totals, not displayed — the budget ran out.
        truncated = true;
        return true;
      }
      const contextBlock =
        context > 0 && matchLines.length > 0 ? renderContextBlock(relPath, lines, matchLines, context) : null;
      files.push({ relPath, totalInFile, matchLines, contextBlock });
      contentBudget -= matchLines.length;
      if (matchLines.length < totalInFile) truncated = true;
    } else {
      files.push({ relPath, totalInFile, matchLines: [], contextBlock: null });
    }
    return true;
  });

  if (files.length === 0 || totalMatches === 0) {
    return { ok: true, output: `no content matches for '${needle}'` };
  }
  const totals =
    `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${matchedFileCount} file${matchedFileCount === 1 ? "" : "s"} for '${needle}'`;

  if (outputMode === "files_with_matches" || outputMode === "count") {
    const listed = files.slice(0, SEARCH_FILE_LIST_CAP);
    const hidden = files.length - listed.length;
    const rows = listed.map((f) =>
      outputMode === "count"
        ? `${f.relPath}: ${f.totalInFile}`
        : `${f.relPath} (${f.totalInFile} match${f.totalInFile === 1 ? "" : "es"})`,
    );
    if (hidden > 0) rows.push(`…${hidden} more matching file${hidden === 1 ? "" : "s"} not shown`);
    const truncationNote = truncated || hidden > 0 ? " (truncated — narrow with dir/file_glob, or raise max_results)" : "";
    return { ok: true, output: `${totals}${truncationNote}\n${rows.join("\n")}` };
  }

  // content mode — grouped per file (walk order), match lines as
  // `file:line: text`, context lines interleaved as `file-line- text`.
  const out: string[] = [];
  for (const f of files) {
    if (f.contextBlock !== null) {
      out.push(...f.contextBlock);
    } else {
      for (const m of f.matchLines) out.push(`${f.relPath}:${m.line}: ${clipSearchLine(m.text)}`);
    }
    const shownInFile = f.matchLines.length;
    if (shownInFile < f.totalInFile) {
      const more = f.totalInFile - shownInFile;
      out.push(`…${more} more match${more === 1 ? "" : "es"} in this file`);
    }
  }
  const truncationNote = truncated
    ? " (truncated — narrow with dir/file_glob, or raise max_results)"
    : "";
  return { ok: true, output: `${totals}${truncationNote}\n${out.join("\n")}` };
}
