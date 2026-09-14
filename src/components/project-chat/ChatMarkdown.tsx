import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, File, FileCode } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import type { ThemeStyles } from "../../lib/themes";
import { withAlpha } from "../dashboard/helpers";
// R97-F: the Prism-backed highlighter (the app's own token palette lives in
// index.css — see src/lib/highlight.ts).
import { highlightLines } from "../../lib/highlight";

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
 *
 * ROUND-95 (R95-F, owner: the chat "occasionally shows weird formatting
 * issues… make it much more robust") — the robustness pass, all surgical on
 * the R64 architecture (still dependency-free, still line-based):
 *   INLINE  `***bold-italic***` · CommonMark flanking guards (`** x **` is
 *           NOT emphasis; intraword `__x__` never bolds) · link destinations
 *           with balanced parens (`…/Foo_(bar)`) or the `<url>` form ·
 *           a scheme allowlist (`javascript:`/`data:` never become links) ·
 *           GFM autolink for bare http(s)/ftp URLs (trailing sentence
 *           punctuation peeled, balanced parens kept) · HTML entity decode
 *           in plain runs (`&amp;` → `&`; code spans/blocks stay verbatim) ·
 *           `break-all` on long unbroken inline-code/URL tokens.
 *   BLOCKS  fenced code carries its INFO STRING as a header language badge
 *           (``` and ~~~ fences, each closing on its own marker) · bullets
 *           nest to ANY depth (indentation/2, capped 6 — the old renderer
 *           flattened depth ≥ 2) · heading closing hashes stripped (`## T ##`)
 *           · table rows with more cells than the header KEEP their extras
 *           (the old renderer dropped overflow cells).
 * The whole component keeps the streaming guarantee above: every new rule
 * fails closed into readable plain text, never raw-markdown flashes.
 */

// ─── Code fences: the EXISTING CodeBlock (moved from AgentChatPanel) ────────

/** Inline code block renderer with copy button (round-24: Kilo Code parity).
 * ROUND-64 (R64-c): moved verbatim from AgentChatPanel so ChatMarkdown can
 * render fenced ``` blocks through the exact same component; AgentChatPanel
 * imports it back from here (single owner, no duplication).
 * ROUND-95 (R95-F): optional `lang` — the fence's INFO STRING (```ts), now
 * captured by the scanner and badged in the header, so a code block's
 * language is visible at a glance (the pre-R95 header showed only the line
 * count; the language was silently discarded).
 * ROUND-97 (R97-F): REAL SYNTAX COLORS — the owner: "in the thinking, if it
 * shows a code block, then that code block should clearly be highlighted.
 * It should clearly be formatted in colors and it should be properly
 * shown." The body renders Prism's token spans (src/lib/highlight.ts — the
 * app's own .token palette in index.css, light + dark); an unknown language
 * or a pathological input falls back to the plain lines (never a crash). */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  // R97-F: the highlighted HTML (null → the plain-lines fallback). Memoized
  // on the exact inputs — a re-render with the same code never re-tokenizes.
  // R97-J (m4): the per-line split — the SAME numbered rows as the plain
  // fallback, colors included (tokens that span lines re-open their spans
  // on each continuation line; see highlightLines). The pre-R97-F gutter
  // is back on highlighted blocks, and both paths wrap identically.
  const highlightedLines = useMemo(() => highlightLines(code, lang), [code, lang]);
  return (
    <div className="my-1.5 rounded-[12px] overflow-hidden border" style={{ borderColor: styles.border }}>
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b"
        style={{ background: styles.subtle, borderColor: styles.border }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {lang !== undefined && lang !== "" ? (
            <span
              data-code-lang={lang}
              className="shrink-0 rounded-[5px] px-1.5 py-px font-mono text-[9.5px] font-bold uppercase tracking-wide"
              style={{
                background: withAlpha(styles.accent, styles.isDark ? 0.16 : 0.1),
                color: styles.accent,
              }}
            >
              {lang}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-[10px] font-bold" style={{ color: styles.textTertiary }}>
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
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
      <pre
        className="acute-code-hl overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.6]"
        style={{ color: styles.text }}
      >
        {highlightedLines !== null
          ? highlightedLines.map((html, i) => (
              <div key={i} className="flex">
                <span
                  className="w-7 shrink-0 text-right pr-3 select-none font-mono text-[10px] leading-[1.6]"
                  style={{ color: styles.textTertiary }}
                >
                  {i + 1}
                </span>
                <span
                  data-code-highlighted
                  // R97-F + R97-J (m4): Prism's per-line output — the app's
                  // OWN palette (index.css's .acute-code-hl .token.* rules;
                  // NO Prism CSS imported), so the colors follow the design
                  // system in both modes. The HTML comes from
                  // src/lib/highlight.ts's token-stream split over the exact
                  // code string — never user-facing HTML passthrough.
                  className="flex-1 whitespace-pre-wrap break-words min-w-0"
                  dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
                />
              </div>
            ))
          : lines.map((line, i) => (
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
 * the cleaned token looks like a file path. Returns the cleaned path or null.
 * ROUND-95 (R95-F): the trailing strip also takes QUOTES — a quoted path
 * followed by sentence punctuation (`"src/app.ts",` — the single most common
 * shape in assistant prose) previously stranded the quote on the token and
 * failed PATH_REGEX, silently losing the pill. */
export function matchPath(token: string): string | null {
  if (token.length === 0) return null;
  let t = token.replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/[.,;:!?)\]"'`]+$/g, "");
  if (t.length === 0) return null;
  if (URL_SCHEME.test(t)) return null;
  if (LEADING_DOT_SLASH.test(t)) return t;
  if (LEADING_SLASH.test(t)) return t;
  if (PATH_REGEX.test(t)) return t;
  return null;
}

// ── ROUND-95 (R95-F): URLs, entities, safe links ─────────────────────────────

/**
 * ROUND-95 (R95-F): the standard HTML entities that actually appear in
 * assistant answers (`&amp;`, `&lt;`, `&#65;`…). Well-formed known entities
 * decode; anything else stays VERBATIM — an unknown entity like `&foo;`
 * is never corrupted into a bare `&`. Code spans and fenced blocks keep
 * their payload verbatim (CommonMark: entities are source text there).
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  dagger: "†",
  prime: "′",
  Prime: "″",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
  harr: "↔",
  ne: "≠",
  le: "≤",
  ge: "≥",
  minus: "−",
};
const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Decode well-formed known entities in one pass (no double-decode:
 * `&amp;lt;` → `&lt;`, never `<`). Exported for tests. */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m: string, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : m;
  });
}

/** ROUND-95 (R95-F): may this URL become an href? A scheme-bearing URL is
 * allowed only on the http/https/ftp/mailto allowlist (a `javascript:` or
 * `data:` payload echoed by the model — or injected from repo file content
 * it quotes — must never become a clickable link); scheme-RELATIVE refs
 * (`#anchor`, `/path`, `?query`) carry no execution semantics and pass. */
const URL_SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_URL_SCHEME_RE = /^(https?|ftp|mailto):/i;

export function isSafeUrl(url: string): boolean {
  if (!URL_SCHEME_PREFIX_RE.test(url)) return true;
  return SAFE_URL_SCHEME_RE.test(url);
}

/** Count occurrences of a single character (paren-balance checks). */
function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n += 1;
  return n;
}

/**
 * ROUND-95 (R95-F): a bare `https?://` / `ftp://` token (GFM autolink) with
 * sentence punctuation peeled — trailing `.,;:!?*_~'"` always goes (the
 * GFM autolink trailing set — a dangling `**` run never gloms onto the
 * URL), a closing `)` only when the URL's own parens don't balance it (so
 * Wikipedia's `…/Foo_(bar)` keeps its group), leading `(["'` wrappers go
 * too. Returns the cleaned URL or null when the token is not a bare URL.
 * The peeled characters are NOT lost — renderPathAwareSegment keeps them
 * visible around the anchor.
 */
export function matchUrl(token: string): string | null {
  if (token.length === 0) return null;
  let t = token.replace(/^[(["'`\s]+/, "");
  t = t.replace(/[.,;:!?*~_'"\]]+$/, "");
  while (t.length > 0 && t.endsWith(")") && countChar(t, "(") < countChar(t, ")")) {
    t = t.slice(0, -1);
  }
  if (!/^(https?|ftp):\/\//i.test(t)) return null;
  return t;
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
 * clickable PathPills, BARE URLs as links (ROUND-95 R95-F: GFM autolink),
 * and the runs between them as single spans (merged —
 * ROUND-64 R64-c: the old per-word spans made every multi-word phrase
 * unqueryable and bloated the DOM; only the pills/links break the text up).
 * Preserves whitespace. Entities decode in the PLAIN runs (never inside
 * code spans — those stay verbatim).
 * ROUND-95 (R95-F): the characters matchUrl/matchPath PEEL off a token
 * (a sentence's trailing `.`/`,`/`**`, wrapping quotes/parens) stay
 * VISIBLE around the pill/anchor — merged into the neighboring plain
 * runs. The pre-R95 code dropped them, so "visit https://x.com." rendered
 * without its period (the owner's "minor issues" class, made worse by the
 * autolink: every URL at the end of a sentence lost its period). */
function renderPathAwareSegment(
  segment: string,
  projectId: string,
  keyPrefix: string,
  styles: ThemeStyles,
): ReactNode[] {
  if (segment.length === 0) return [];
  const tokens = segment.split(/(\s+)/);
  const out: ReactNode[] = [];
  let plain = "";
  let flushIdx = 0;
  const flushPlain = (): void => {
    if (plain !== "") {
      out.push(<span key={`${keyPrefix}-t-${flushIdx}`}>{decodeEntities(plain)}</span>);
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
    const url = matchUrl(tok);
    if (url !== null) {
      // The peeled prefix (wrapping quotes/parens) merges into the plain
      // run BEFORE the anchor; the peeled suffix (sentence punctuation,
      // dangling asterisk runs) into the run AFTER it. matchUrl only ever
      // strips from the two ENDS, so indexOf finds the URL exactly.
      const at = tok.indexOf(url);
      plain += tok.slice(0, at);
      flushPlain();
      flushIdx = i;
      out.push(
        <a
          key={`${keyPrefix}-u-${i}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 break-all"
          style={{ color: styles.accent }}
        >
          {url}
        </a>,
      );
      plain += tok.slice(at + url.length);
      continue;
    }
    const path = matchPath(tok);
    if (path !== null) {
      const at = tok.indexOf(path);
      plain += tok.slice(0, at);
      flushPlain();
      flushIdx = i;
      out.push(<PathPill key={`${keyPrefix}-p-${i}`} path={decodeEntities(path)} projectId={projectId} />);
      plain += tok.slice(at + path.length);
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
  kind: "code" | "bolditalic" | "bold" | "italic" | "strike" | "link";
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
 * cannot double-wrap. ROUND-95 (R95-F) fixes on the R64 ladder:
 *  · `***bold-italic***` is its own mark (first alternative) — the old
 *    pattern left stray `*`s around a bold run for triple-asterisk runs;
 *  · CommonMark flanking guards: `** x **` / `* x *` / `~~ x ~~` (space
 *    right after the opener / before the closer) are NOT emphasis, so a
 *    stray `5 * 3 * 2` arithmetic line never italicizes; intraword `__x__`
 *    (snake__case__names) never bolds (lookbehind/lookahead guards — the
 *    engine slices from `from`, and a slice START is never intraword
 *    because positions only ever advance past complete marks);
 *  · link destinations may carry ONE level of balanced parens
 *    (`[wiki](https://en.wikipedia.org/wiki/Foo_(bar))`) or the angle form
 *    `[text](<url>)` — the old `[^)\s]+` truncated at the first `)`.
 * NON-global (no lastIndex state — renderInline recurses, and a shared
 * global regex would corrupt position tracking); the search runs on a
 * slice from `from`. */
const MARK_SOURCE =
  "\\*\\*\\*(?![\\s])([^*\\n]+?)(?<!\\s)\\*\\*\\*" +
  "|\\*\\*(?![\\s])([^*\\n]+?)(?<!\\s)\\*\\*" +
  "|(?<![a-zA-Z0-9_])__(?![\\s])([^_\\n]+?)(?<!\\s)__(?![a-zA-Z0-9_])" +
  "|~~(?![\\s])([^~\\n]+?)(?<!\\s)~~" +
  "|\\*(?![\\s])([^*\\n]+?)(?<!\\s)\\*" +
  "|\\[([^\\]\\n]+)\\]\\(<([^<>\\n]+)>\\)" +
  "|\\[([^\\]\\n]+)\\]\\(([^()\\s]+(?:\\([^()\\s]*\\)[^()\\s]*)*)\\)" +
  "|\\b_(?![\\s])([^_\\n]+?)(?<!\\s)_\\b";
const MARK_RE = new RegExp(MARK_SOURCE);

function findMark(text: string, from: number): MarkMatch | null {
  const m = MARK_RE.exec(text.slice(from));
  if (m === null) return null;
  if (m[1] !== undefined) return { index: from + m.index, raw: m[0], inner: m[1], kind: "bolditalic" };
  if (m[2] !== undefined) return { index: from + m.index, raw: m[0], inner: m[2], kind: "bold" };
  if (m[3] !== undefined) return { index: from + m.index, raw: m[0], inner: m[3], kind: "bold" };
  if (m[4] !== undefined) return { index: from + m.index, raw: m[0], inner: m[4], kind: "strike" };
  if (m[5] !== undefined) return { index: from + m.index, raw: m[0], inner: m[5], kind: "italic" };
  if (m[6] !== undefined && m[7] !== undefined) {
    return { index: from + m.index, raw: m[0], inner: m[6], url: m[7], kind: "link" };
  }
  if (m[8] !== undefined && m[9] !== undefined) {
    return { index: from + m.index, raw: m[0], inner: m[8], url: m[9], kind: "link" };
  }
  if (m[10] !== undefined) return { index: from + m.index, raw: m[0], inner: m[10], kind: "italic" };
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
 * path-aware plain text (ROUND-40 pills + R95-F bare-URL links). */
function renderInline(text: string, projectId: string, keyPrefix: string, styles: ThemeStyles): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (;;) {
    const mark = nextMark(text, pos);
    if (mark === null) break;
    if (mark.index > pos) {
      for (const seg of renderPathAwareSegment(text.slice(pos, mark.index), projectId, `${keyPrefix}-g${k}`, styles)) {
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
            className="px-1.5 py-0.5 rounded-md text-[11.5px] font-mono break-all"
            style={{
              background: withAlpha(styles.accent, styles.isDark ? 0.13 : 0.08),
              color: styles.text,
            }}
          >
            {mark.inner}
          </code>,
        );
      }
    } else if (mark.kind === "bolditalic") {
      out.push(
        <strong key={`${keyPrefix}-bi${k}`} style={{ fontWeight: 700 }}>
          <em>{renderInline(mark.inner, projectId, `${keyPrefix}-bii${k}`, styles)}</em>
        </strong>,
      );
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
      // ROUND-95 (R95-F): the destination decodes entities + passes the
      // scheme allowlist; an UNSAFE scheme (javascript:/data:) renders as
      // plain text — never a clickable link — keeping the raw markdown
      // visible instead of a half-eaten construct.
      const url = decodeEntities(mark.url as string);
      if (isSafeUrl(url)) {
        out.push(
          <a
            key={`${keyPrefix}-l${k}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 break-all"
            style={{ color: styles.accent }}
          >
            {renderInline(mark.inner, projectId, `${keyPrefix}-li${k}`, styles)}
          </a>,
        );
      } else {
        for (const seg of renderPathAwareSegment(mark.raw, projectId, `${keyPrefix}-lx${k}`, styles)) {
          out.push(seg);
        }
      }
    }
    pos = mark.index + mark.raw.length;
    k += 1;
  }
  if (pos < text.length) {
    for (const seg of renderPathAwareSegment(text.slice(pos), projectId, `${keyPrefix}-t${k}`, styles)) {
      out.push(seg);
    }
  }
  return out;
}

// ─── Block model + the pure line scanner (exported for tests) ───────────────

/** One parsed markdown block. ROUND-95 (R95-F): `code` carries the fence's
 * info string (`lang` — "" when absent) and bullets carry an ARBITRARY
 * `level` (indentation / 2 spaces — the old binary 0|1 flattened depth-2+
 * nests onto depth 1). */
export type MdBlock =
  | { kind: "code"; code: string; lang: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "quote"; lines: string[] }
  | { kind: "bullets"; items: { level: number; text: string }[] }
  | { kind: "numbers"; items: { marker: string; text: string }[] }
  | { kind: "table"; header: string[]; aligns: ("left" | "center" | "right")[]; rows: string[][] }
  | { kind: "para"; lines: string[] };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
const HR_RE = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.+)$/;
const NUMBER_RE = /^(\s*)(\d{1,9})[.)]\s+(.+)$/;
/** ROUND-95 (R95-F): backtick AND tilde fences (GFM parity — a model that
 * writes ~~~js gets a code block too), each closing on its OWN marker. */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const FENCE_INFO_RE = /^\s{0,3}(```|~~~)\s*(\S*)/;

/** The fence marker a line opens with (``` or ~~~), or null — the closer
 * must match the opener so a ``` block does not close on a ~~~ line. */
function fenceMarker(line: string): "```" | "~~~" | null {
  const m = FENCE_INFO_RE.exec(line);
  if (m === null) return null;
  return m[1] as "```" | "~~~";
}

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
 * block list. Handles: fenced code (backtick or tilde fences, INCLUDING an
 * unterminated trailing fence — a mid-stream answer's dangling fence still
 * renders as a code block, never raw; the info string is captured as
 * `lang`), headings (with their optional closing `##` run stripped, GFM),
 * hr, blockquotes, bullet/numbered lists, GFM tables, and paragraphs
 * (consecutive non-blank lines). Blank lines separate blocks. Exported for
 * ChatMarkdown.test.tsx.
 */
export function parseMarkdownBlocks(content: string): MdBlock[] {
  const lines = content.split("\n");
  const out: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — consumes to the closing fence (same marker) OR the end
    // of input (a mid-stream dangling fence still renders its partial
    // content as a code block).
    const marker = fenceMarker(line);
    if (marker !== null) {
      const info = FENCE_INFO_RE.exec(line);
      const lang = info !== null ? info[2] : "";
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && fenceMarker(lines[i]) !== marker) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (or past EOF)
      out.push({ kind: "code", code: buf.join("\n"), lang });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      // ROUND-95 (R95-F): `## Title ##` — the closing hash run is a heading
      // closer in GFM, not text (but `C#` keeps its hash: the closer needs
      // leading whitespace).
      const text = h[2].replace(/\s+#+\s*$/, "").trim() || h[2].trim();
      out.push({ kind: "heading", level: h[1].length, text });
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
    // ROUND-95 (R95-F): nesting DEPTH from indentation (2 spaces per level,
    // a tab counts as 2, capped at 6 so a model's runaway indentation can
    // not push content off the chat column — the old binary 0|1 flattened
    // depth-2+ nests onto depth 1).
    const bulletLevel = (indent: string): number =>
      Math.min(6, Math.floor(indent.replace(/\t/g, "  ").length / 2));
    const b = BULLET_RE.exec(line);
    if (b) {
      const items: { level: number; text: string }[] = [{ level: bulletLevel(b[1]), text: b[3] }];
      i += 1;
      while (i < lines.length) {
        const b2 = BULLET_RE.exec(lines[i]);
        if (b2 === null) break;
        items.push({ level: bulletLevel(b2[1]), text: b2[3] });
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
        return <CodeBlock key={`md-code-${i}`} code={b.code} lang={b.lang} />;

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
              <div
                key={j}
                className="flex gap-1.5 min-w-0"
                style={it.level > 0 ? { paddingLeft: `${it.level * 16}px` } : undefined}
              >
                <span className="shrink-0 select-none text-[11px] leading-[1.65]" style={{ color: styles.textTertiary }} aria-hidden>
                  {it.level > 0 ? "◦" : "•"}
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

      case "table": {
        // ROUND-95 (R95-F): a row with MORE cells than the header keeps its
        // extra cells (GFM renders them under implicit empty headers) — the
        // old `b.header.map` silently DROPPED overflow cells (data loss in
        // display). Column count = the widest row/header.
        const colCount = Math.max(b.header.length, ...b.rows.map((row) => row.length));
        return (
          <div
            key={`md-tbl-${i}`}
            className="my-1.5 min-w-0 overflow-x-auto rounded-[10px] border"
            style={{ borderColor: styles.border }}
          >
            <table className="w-full border-collapse text-[11px]" style={{ color: styles.text }}>
              <thead>
                <tr>
                  {Array.from({ length: colCount }, (_, j) => (
                    <th
                      key={j}
                      className="px-2 py-1 font-semibold text-left min-w-0"
                      style={{
                        background: styles.subtle,
                        textAlign: b.aligns[j] ?? "left",
                        borderBottom: `1px solid ${styles.border}`,
                      }}
                    >
                      {j < b.header.length ? renderInline(b.header[j], projectId, `th${i}-${j}`, styles) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {Array.from({ length: colCount }, (_, j) => {
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
      }

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
