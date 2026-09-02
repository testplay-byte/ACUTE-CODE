import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy, File, FileCode } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import type { ThemeStyles } from "../../lib/themes";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-64 (R64-c, owner: "there was apparently no formatting of the response
 * the agent gave me… Make sure it gets formatted like it should be, with the
 * boldness made bold and various other things"): a dependency-free,
 * line-based markdown renderer for CHAT ANSWER TEXT. The pre-R64 RichText/
 * RichTextInline pair in AgentChatPanel only handled ``` fences, `**bold**`
 * and `inline code` — headings, lists, tables, italics, links and rules
 * printed as RAW TEXT (the owner's pasted replies were full of `##` and `-`
 * bullets that showed verbatim).
 *
 * Supersedes that pair (AgentChatPanel now renders final answers, live
 * streaming text AND intermediate working-text entries through THIS
 * component). The repo precedent is FileViewerPanel's `Markdown` — read,
 * but the chat needs the richer feature set:
 *
 *   BLOCKS  headings h1–h6 · `---`/`***` rules · blockquotes `>` · bullets
 *           (`-`/`*`/`+`, one nesting level via indentation) · numbered
 *           lists · GFM tables (header + `|---|` separator detection) ·
 *           paragraphs · fenced code (the EXISTING CodeBlock component,
 *           moved here verbatim — an UNTERMINATED fence still renders as a
 *           code block so mid-stream partial markdown stays readable).
 *   INLINE  `**bold**` · `*italic*`/`_italic_` · `__bold__` · `` `code` `` ·
 *           `~~strike~~` · `[text](url)` links (target=_blank) · and the
 *           ROUND-40 path-pill behavior VERBATIM: file-path-like tokens,
 *           bare OR inside inline code, render as clickable PathPills that
 *           open the file in the right sidebar.
 *
 * Streaming-friendly by design: parseMarkdownBlocks is a pure line scanner,
 * so a HALF-ARRIVED answer renders line-by-line (a dangling `**` or an open
 * fence degrades gracefully instead of flashing raw).
 */

// ─── Code fences: the EXISTING CodeBlock (moved from AgentChatPanel) ────────

/** Inline code block renderer with copy button (round-24: Kilo Code parity).
 * ROUND-64 (R64-c): moved verbatim from AgentChatPanel so ChatMarkdown can
 * render fenced ``` blocks through the exact same component; AgentChatPanel
 * imports it back from here (single owner, no duplication). */
export function CodeBlock({ code }: { code: string }) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  return (
    <div className="my-1.5 rounded-[12px] overflow-hidden border" style={{ borderColor: styles.border }}>
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b"
        style={{ background: styles.subtle, borderColor: styles.border }}
      >
        <span className="font-mono text-[10px] font-bold" style={{ color: styles.textTertiary }}>
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            resetAfter(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors"
          style={{ color: styles.textTertiary }}
          aria-label="Copy code"
        >
          {copied ? <Check size={10} style={{ color: "#22c55e" }} /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.6]" style={{ color: styles.text }}>
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-7 shrink-0 text-right pr-3 select-none font-mono text-[10px] leading-[1.6]" style={{ color: styles.textTertiary }}>
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

// ─── ROUND-40 path pills (moved from AgentChatPanel, behavior verbatim) ─────

/** ROUND-40 (owner: "when the user clicks a file path… it should
 * automatically open in the right sidebar"): detect file-path-like tokens in
 * assistant answer text and render them as clickable pills that call
 * `useRightSidebarStore.getState().openFile(projectId, path)`. Conservative —
 * avoids false positives like `Done.`, `i.e.`, version numbers, URLs. */
const URL_SCHEME = /^(https?|ftp):\/\//i;
const LEADING_DOT_SLASH = /^\.{1,2}[/\\]/;
const LEADING_SLASH = /^[/\\]/;
/** Path shape: word/slash chars + one-or-more dotted segments, where the
 * FINAL segment is 2–4 lowercase letters (a real file extension). Intermediate
 * segments may include digits (e.g. `index.test.ts`, `app.component.tsx`). */
const PATH_REGEX = /^[a-zA-Z0-9_\-/]+(?:\.[a-z0-9]{1,10})*\.[a-z]{2,4}$/;

/** Strip surrounding quotes/backticks + trailing punctuation, then test if
 * the cleaned token looks like a file path. Returns the cleaned path or null. */
export function matchPath(token: string): string | null {
  if (token.length === 0) return null;
  let t = token.replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/[.,;:!?)\]]+$/g, "");
  if (t.length === 0) return null;
  if (URL_SCHEME.test(t)) return null;
  if (LEADING_DOT_SLASH.test(t)) return t;
  if (LEADING_SLASH.test(t)) return t;
  if (PATH_REGEX.test(t)) return t;
  return null;
}

/** Inline clickable pill for a file path — opens it in the right sidebar. */
export function PathPill({ path, projectId }: { path: string; projectId: string }) {
  const styles = useThemeStyles();
  const isCodeLike = /\.(t|j)sx?$|\.py$|\.rs$|\.go$|\.sh$|\.json$|\.toml$|\.ya?ml$|\.xml$|\.html?$|\.css$|\.scss$|\.md$|\.txt$|\.vue$|\.svelte$/i.test(path);
  const Icon = isCodeLike ? FileCode : File;
  return (
    <button
      type="button"
      onClick={() => useRightSidebarStore.getState().openFile(projectId, path)}
      title={`Open ${path} in sidebar`}
      aria-label={`Open ${path} in sidebar`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-[11.5px] transition-colors align-middle cursor-pointer max-w-full overflow-hidden"
      style={{
        background: withAlpha(styles.accent, styles.isDark ? 0.13 : 0.08),
        color: styles.text,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = withAlpha(styles.accent, styles.isDark ? 0.22 : 0.16);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = withAlpha(styles.accent, styles.isDark ? 0.13 : 0.08);
      }}
    >
      <Icon size={10} className="shrink-0" style={{ color: styles.accent }} />
      {/* ROUND-43: a very long path can never widen the chat — the label
          ellipsizes inside the pill instead (the full path is on the title). */}
      <span className="min-w-0 flex-1 truncate">{path}</span>
    </button>
  );
}

/** Tokenize a plain-text segment by whitespace, render path-like tokens as
 * clickable PathPills and the runs between them as single spans (merged —
 * ROUND-64 R64-c: the old per-word spans made every multi-word phrase
 * unqueryable and bloated the DOM; only the pills break the text up).
 * Preserves whitespace. */
function renderPathAwareSegment(segment: string, projectId: string, keyPrefix: string): ReactNode[] {
  if (segment.length === 0) return [];
  const tokens = segment.split(/(\s+)/);
  const out: ReactNode[] = [];
  let plain = "";
  let flushIdx = 0;
  const flushPlain = (): void => {
    if (plain !== "") {
      out.push(<span key={`${keyPrefix}-t-${flushIdx}`}>{plain}</span>);
      plain = "";
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "") continue;
    if (/^\s+$/.test(tok)) {
      plain += tok;
      continue;
    }
    const path = matchPath(tok);
    if (path !== null) {
      flushPlain();
      flushIdx = i;
      out.push(<PathPill key={`${keyPrefix}-p-${i}`} path={path} projectId={projectId} />);
    } else {
      plain += tok;
    }
  }
  flushPlain();
  return out;
}

// ─── Inline marks: code · bold · italic · strike · links (recursive) ─────────

/** One inline-mark occurrence: where it starts, its full span, and the inner
 * text to re-render recursively (`inner` is the verbatim payload for code). */
interface MarkMatch {
  index: number;
  raw: string;
  inner: string;
  url?: string;
  kind: "code" | "bold" | "italic" | "strike" | "link";
}

/** Inline-code spans are matched FIRST (their content is verbatim — no
 * nested marks; path-pill detection inside them stays, per ROUND-40). */
function findCodeSpan(text: string, from: number): MarkMatch | null {
  const open = text.indexOf("`", from);
  if (open === -1) return null;
  const close = text.indexOf("`", open + 1);
  if (close === -1) return null;
  if (text.slice(open, close + 1).includes("\n")) return null;
  return { index: open, raw: text.slice(open, close + 1), inner: text.slice(open + 1, close), kind: "code" };
}

/** The remaining marks as ONE alternation — earliest match wins, overlaps
 * cannot double-wrap. `**bold**`/`__bold__` before `*italic*`/`_italic_`;
 * the single-underscore italic is word-boundary-guarded so
 * `snake_case_words` never italicizes. NON-global (no lastIndex state —
 * renderInline recurses, and a shared global regex would corrupt position
 * tracking); the search runs on a slice from `from`. */
const MARK_SOURCE =
  "\\*\\*([^*\\n]+)\\*\\*|__([^_\\n]+)__|~~([^~\\n]+)~~|\\*([^*\\n]+)\\*|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|\\b_([^_\\n]+)_\\b";
const MARK_RE = new RegExp(MARK_SOURCE);

function findMark(text: string, from: number): MarkMatch | null {
  const m = MARK_RE.exec(text.slice(from));
  if (m === null) return null;
  if (m[1] !== undefined) return { index: from + m.index, raw: m[0], inner: m[1], kind: "bold" };
  if (m[2] !== undefined) return { index: from + m.index, raw: m[0], inner: m[2], kind: "bold" };
  if (m[3] !== undefined) return { index: from + m.index, raw: m[0], inner: m[3], kind: "strike" };
  if (m[4] !== undefined) return { index: from + m.index, raw: m[0], inner: m[4], kind: "italic" };
  if (m[5] !== undefined && m[6] !== undefined) {
    return { index: from + m.index, raw: m[0], inner: m[5], url: m[6], kind: "link" };
  }
  if (m[7] !== undefined) return { index: from + m.index, raw: m[0], inner: m[7], kind: "italic" };
  return null;
}

/** The earliest inline mark at/after `from` (code spans beat other marks at
 * the same position; otherwise whichever starts first). */
function nextMark(text: string, from: number): MarkMatch | null {
  const code = findCodeSpan(text, from);
  const mark = findMark(text, from);
  if (code === null && mark === null) return null;
  if (code !== null && (mark === null || code.index <= mark.index)) return code;
  return mark;
}

/** Render one run of inline markdown (per line — never spans `\n`).
 * Recursive: the inner text of bold/italic/strike/link re-parses, so paths
 * and nested marks inside emphasis still render. Gaps between marks render
 * path-aware plain text (ROUND-40 pills). */
function renderInline(text: string, projectId: string, keyPrefix: string, styles: ThemeStyles): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (;;) {
    const mark = nextMark(text, pos);
    if (mark === null) break;
    if (mark.index > pos) {
      for (const seg of renderPathAwareSegment(text.slice(pos, mark.index), projectId, `${keyPrefix}-g${k}`)) {
        out.push(seg);
      }
    }
    if (mark.kind === "code") {
      // Inline code; if its content is a path, render as a PathPill
      // (owner: "a path inside backticks should become a clickable path
      // pill, which is fine").
      const codePath = matchPath(mark.inner);
      if (codePath !== null) {
        out.push(<PathPill key={`${keyPrefix}-cp${k}`} path={codePath} projectId={projectId} />);
      } else {
        out.push(
          <code
            key={`${keyPrefix}-c${k}`}
            className="px-1.5 py-0.5 rounded-md text-[11.5px] font-mono"
            style={{
              background: withAlpha(styles.accent, styles.isDark ? 0.13 : 0.08),
              color: styles.text,
            }}
          >
            {mark.inner}
          </code>,
        );
      }
    } else if (mark.kind === "bold") {
      out.push(
        <strong key={`${keyPrefix}-b${k}`} style={{ fontWeight: 700 }}>
          {renderInline(mark.inner, projectId, `${keyPrefix}-bi${k}`, styles)}
        </strong>,
      );
    } else if (mark.kind === "italic") {
      out.push(
        <em key={`${keyPrefix}-i${k}`}>{renderInline(mark.inner, projectId, `${keyPrefix}-ii${k}`, styles)}</em>,
      );
    } else if (mark.kind === "strike") {
      out.push(
        <del key={`${keyPrefix}-s${k}`}>{renderInline(mark.inner, projectId, `${keyPrefix}-si${k}`, styles)}</del>,
      );
    } else if (mark.kind === "link") {
      out.push(
        <a
          key={`${keyPrefix}-l${k}`}
          href={mark.url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
          style={{ color: styles.accent }}
        >
          {renderInline(mark.inner, projectId, `${keyPrefix}-li${k}`, styles)}
        </a>,
      );
    }
    pos = mark.index + mark.raw.length;
    k += 1;
  }
  if (pos < text.length) {
    for (const seg of renderPathAwareSegment(text.slice(pos), projectId, `${keyPrefix}-t${k}`)) {
      out.push(seg);
    }
  }
  return out;
}

// ─── Block model + the pure line scanner (exported for tests) ───────────────

/** One parsed markdown block. */
export type MdBlock =
  | { kind: "code"; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "quote"; lines: string[] }
  | { kind: "bullets"; items: { level: 0 | 1; text: string }[] }
  | { kind: "numbers"; items: { marker: string; text: string }[] }
  | { kind: "table"; header: string[]; aligns: ("left" | "center" | "right")[]; rows: string[][] }
  | { kind: "para"; lines: string[] };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
const HR_RE = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.+)$/;
const NUMBER_RE = /^(\s*)(\d{1,9})[.)]\s+(.+)$/;
const FENCE_RE = /^\s{0,3}```/;

/** A `| --- | :--: |` separator line → its cells, or null when the line is
 * not a valid GFM separator. */
function tableSeparatorCells(line: string): string[] | null {
  let s = line.trim();
  if (!s.includes("-")) return null;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = s.split("|").map((c) => c.trim());
  if (cells.length === 0 || cells.some((c) => !/^:?-{1,}:?$/.test(c))) return null;
  return cells;
}

/** Split a table row into trimmed cells (outer pipes stripped). */
function tableRowCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** Alignment for one separator cell (`:--:` → center, `--:` → right). */
function separatorAlign(cell: string): "left" | "center" | "right" {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** Cells that look purely numeric render in monospace (data tables read
 * better with tabular figures). */
const NUMERIC_CELL_RE = /^[+-]?\d[\d.,]*(?:%|[kKmMsS])?$/;

/** Does this line START a non-paragraph block (paragraph continuation
 * guard — a paragraph stops at any recognized block opener). */
function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    NUMBER_RE.test(line)
  );
}

/**
 * The pure line scanner — one pass over `content.split("\n")` producing the
 * block list. Handles: fenced code (INCLUDING an unterminated trailing
 * fence — a mid-stream answer's dangling fence still renders as a code
 * block, never raw), headings, hr, blockquotes, bullet/numbered lists, GFM
 * tables, and paragraphs (consecutive non-blank lines). Blank lines
 * separate blocks. Exported for ChatMarkdown.test.tsx.
 */
export function parseMarkdownBlocks(content: string): MdBlock[] {
  const lines = content.split("\n");
  const out: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — consumes to the closing ``` OR the end of input.
    if (FENCE_RE.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (or past EOF)
      out.push({ kind: "code", code: buf.join("\n") });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, text: h[2] });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const q = QUOTE_RE.exec(line);
    if (q) {
      const quote: string[] = [q[1]];
      i += 1;
      while (i < lines.length) {
        const q2 = QUOTE_RE.exec(lines[i]);
        if (q2 === null) break;
        quote.push(q2[1]);
        i += 1;
      }
      out.push({ kind: "quote", lines: quote });
      continue;
    }

    // GFM table: a `|`-bearing line whose NEXT line is a separator row.
    if (line.includes("|") && i + 1 < lines.length && tableSeparatorCells(lines[i + 1]) !== null) {
      const header = tableRowCells(line);
      const aligns = (tableSeparatorCells(lines[i + 1]) as string[]).map(separatorAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(tableRowCells(lines[i]));
        i += 1;
      }
      out.push({ kind: "table", header, aligns, rows });
      continue;
    }

    // Lists — consecutive items of the SAME kind group into one block.
    const b = BULLET_RE.exec(line);
    if (b) {
      const items: { level: 0 | 1; text: string }[] = [{ level: b[1].length >= 2 ? 1 : 0, text: b[3] }];
      i += 1;
      while (i < lines.length) {
        const b2 = BULLET_RE.exec(lines[i]);
        if (b2 === null) break;
        items.push({ level: b2[1].length >= 2 ? 1 : 0, text: b2[3] });
        i += 1;
      }
      out.push({ kind: "bullets", items });
      continue;
    }

    const n = NUMBER_RE.exec(line);
    if (n) {
      const items: { marker: string; text: string }[] = [{ marker: n[2], text: n[3] }];
      i += 1;
      while (i < lines.length) {
        const n2 = NUMBER_RE.exec(lines[i]);
        if (n2 === null) break;
        items.push({ marker: n2[2], text: n2[3] });
        i += 1;
      }
      out.push({ kind: "numbers", items });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: consecutive lines that start no other block.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push({ kind: "para", lines: para });
  }

  return out;
}

// ─── The renderer ────────────────────────────────────────────────────────────

/** Heading sizes per the R64-c spec: h1/h2/h3 as styled blocks (~15/13.5/
 * 12.5px, bold); h4–h6 as bold body-size paragraphs. */
const HEADING_SIZES: Record<number, string> = { 1: "15px", 2: "13.5px", 3: "12.5px" };
const HEADING_MARGINS: Record<number, string> = { 1: "mt-3 mb-1", 2: "mt-2.5 mb-1", 3: "mt-2 mb-0.5" };

/** Render the parsed blocks (module-level: pure given styles + projectId). */
function renderBlocks(content: string, projectId: string, styles: ThemeStyles): ReactNode[] {
  const blocks = parseMarkdownBlocks(content);
  return blocks.map((b, i) => {
    switch (b.kind) {
      case "code":
        return <CodeBlock key={`md-code-${i}`} code={b.code} />;

      case "heading": {
        const size = HEADING_SIZES[b.level];
        if (size !== undefined) {
          return (
            <div
              key={`md-h-${i}`}
              className={`${HEADING_MARGINS[b.level]} font-bold break-words`}
              style={{ fontSize: size, color: styles.text }}
            >
              {renderInline(b.text, projectId, `h${i}`, styles)}
            </div>
          );
        }
        // h4–h6: bold paragraphs at body size.
        return (
          <div key={`md-h-${i}`} className="mt-1.5 mb-0.5 font-bold break-words" style={{ color: styles.text }}>
            {renderInline(b.text, projectId, `h${i}`, styles)}
          </div>
        );
      }

      case "hr":
        return <div key={`md-hr-${i}`} className="my-2 border-t" style={{ borderColor: styles.borderSubtle }} aria-hidden />;

      case "quote":
        return (
          <div
            key={`md-q-${i}`}
            className="my-1.5 pl-2.5 border-l-2 break-words"
            style={{ borderColor: styles.borderStrong, color: styles.textSecondary }}
          >
            {b.lines.map((l, j) => (
              <div key={j} className={j > 0 ? "mt-1" : undefined}>
                {renderInline(l, projectId, `q${i}-${j}`, styles)}
              </div>
            ))}
          </div>
        );

      case "bullets":
        return (
          <div key={`md-ul-${i}`} className="my-1 flex flex-col gap-0.5 min-w-0">
            {b.items.map((it, j) => (
              <div key={j} className={`flex gap-1.5 min-w-0 ${it.level === 1 ? "pl-4" : ""}`}>
                <span className="shrink-0 select-none text-[11px] leading-[1.65]" style={{ color: styles.textTertiary }} aria-hidden>
                  {it.level === 1 ? "◦" : "•"}
                </span>
                <span className="min-w-0 flex-1">{renderInline(it.text, projectId, `ul${i}-${j}`, styles)}</span>
              </div>
            ))}
          </div>
        );

      case "numbers":
        return (
          <div key={`md-ol-${i}`} className="my-1 flex flex-col gap-0.5 min-w-0">
            {b.items.map((it, j) => (
              <div key={j} className="flex gap-1.5 min-w-0">
                <span className="shrink-0 select-none font-mono text-[11px] leading-[1.65]" style={{ color: styles.textTertiary }}>
                  {it.marker}.
                </span>
                <span className="min-w-0 flex-1">{renderInline(it.text, projectId, `ol${i}-${j}`, styles)}</span>
              </div>
            ))}
          </div>
        );

      case "table":
        return (
          <div
            key={`md-tbl-${i}`}
            className="my-1.5 min-w-0 overflow-x-auto rounded-[10px] border"
            style={{ borderColor: styles.border }}
          >
            <table className="w-full border-collapse text-[11px]" style={{ color: styles.text }}>
              <thead>
                <tr>
                  {b.header.map((cell, j) => (
                    <th
                      key={j}
                      className="px-2 py-1 font-semibold text-left min-w-0"
                      style={{
                        background: styles.subtle,
                        textAlign: b.aligns[j] ?? "left",
                        borderBottom: `1px solid ${styles.border}`,
                      }}
                    >
                      {renderInline(cell, projectId, `th${i}-${j}`, styles)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {b.header.map((_, j) => {
                      const cell = row[j] ?? "";
                      return (
                        <td
                          key={j}
                          className={`px-2 py-1 min-w-0 ${NUMERIC_CELL_RE.test(cell) ? "font-mono" : ""}`}
                          style={{
                            textAlign: b.aligns[j] ?? "left",
                            borderTop: r > 0 ? `1px solid ${styles.borderSubtle}` : undefined,
                          }}
                        >
                          {renderInline(cell, projectId, `td${i}-${r}-${j}`, styles)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "para":
        return (
          <div key={`md-p-${i}`} className="mt-1 mb-0.5 break-words">
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {renderInline(l, projectId, `p${i}-${j}`, styles)}
              </Fragment>
            ))}
          </div>
        );
    }
  });
}

/**
 * The chat answer renderer. Drop-in for the old RichText: same props, same
 * path-pill + CodeBlock behavior, plus full markdown blocks. Line-based, so
 * a mid-stream partial answer renders progressively (render line-by-line).
 */
export function ChatMarkdown({ content, projectId }: { content: string; projectId: string }) {
  const styles = useThemeStyles();
  return <div className="min-w-0 break-words">{renderBlocks(content, projectId, styles)}</div>;
}
