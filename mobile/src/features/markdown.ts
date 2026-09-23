/**
 * markdown.ts — the pure markdown parser for the transcript (R109: "The
 * responses are not formatted, some responses are not made bold" — fixed
 * at the source). Model-emitted markdown, honestly parsed:
 *
 *   BLOCKS: fenced code (```…```), headings #..####, hr, blockquotes,
 *           ordered/unordered lists (ONE nesting level), pipe tables,
 *           paragraphs
 *   INLINE: **bold**, *italic* / _italic_, `code`, ~~strike~~,
 *           [text](url)
 *
 * Pure string → Block[] (unit-testable); the renderer
 * (components/markdown-text.tsx) is the only consumer.
 * Re-parsing on every stream delta is O(n) on content length — cheap
 * enough for a live turn (a 30 KB message parses in single-digit ms).
 *
 * ROUND-120 (R120-CM, §1 item 41 — "no proper headings"): the HEADING
 * TIER RECIPE lives here too (`headingTier`) — markdown levels 1-4 map
 * onto the house Type ladder (tokens.ts's TYPE_* constants, imported —
 * the ladder is the contract, the recipe never inlines a size). The
 * renderer maps the recipe's weight onto fontFamily.bold/semibold; jest
 * pins the table right beside the parser it serves.
 */

import { TYPE_BODY, TYPE_HEADING, TYPE_TITLE } from "@/design/tokens";

// ── the inline token tree ───────────────────────────────────────────────────

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "italic"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "strike"; c: Inline[] }
  | { t: "link"; text: string; href: string };

// ── the block tree ──────────────────────────────────────────────────────────

export type ListItem = { inlines: Inline[]; sub: Inline[] | null };

export type Block =
  | { t: "paragraph"; inlines: Inline[] }
  | { t: "code"; lang: string | null; lines: string[] }
  | { t: "heading"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { t: "quote"; inlines: Inline[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

// ── the heading tier recipe (R120-CM, §1 item 41) ────────────────────────────

/** One markdown heading's house tier — the size + weight pair the renderer
 *  maps onto the type ladder (700 → fontFamily.bold, 600 → fontFamily.semibold).
 *  Pure data; `headingTier` is the single source. */
export interface HeadingTier {
  /** The ladder's size slot (tokens.ts TYPE_*). */
  size: number;
  /** The ladder's weight slot (the weight law: 700 card/section titles,
   *  600 row-title strength one step down). */
  weight: 600 | 700;
}

/**
 * R120-CM — the markdown heading → house Type tier table (the owner's
 * "no proper headings" verdict on the mobile center; typography.md's
 * hierarchy): H1 the TITLE tier (20/700 — the document's one headline;
 * DISPLAY 28 stays wizard-only), H2 the HEADING tier (16/700), H3 the
 * HEADING tier one weight down (16/600 — the ladder's row-title weight,
 * a visible step without a rogue size), H4 the BODYSTRONG tier (15/600 —
 * the run-in heading). The sizes read the ladder's own constants — a
 * tier drift here is a compile-time import away, never an inline number.
 * Dense + textScale never touch the heading ladder (the R114-d
 * calibration-mark law: the chatTextSize pref scales the PARAGRAPH body
 * only). Pure.
 */
export function headingTier(level: 1 | 2 | 3 | 4): HeadingTier {
  switch (level) {
    case 1:
      return { size: TYPE_TITLE, weight: 700 };
    case 2:
      return { size: TYPE_HEADING, weight: 700 };
    case 3:
      return { size: TYPE_HEADING, weight: 600 };
    case 4:
      return { size: TYPE_BODY, weight: 600 };
  }
}

// ── the inline parser ───────────────────────────────────────────────────────

/** All the inline markers we recognize, longest-first so `` ` `` vs `` `` ``
 * style ambiguity never misfires. */
const INLINE_RE =
  /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(__([^_\n]+)__)|(`([^`\n]+)`)|(~~([^~\n]+)~~)|(\[([^\]\n]+)\]\(([^)\s]+)\))/;

/** Parse ONE inline string into the token tree. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest !== "") {
    const m = INLINE_RE.exec(rest);
    if (m === null || m.index === undefined) {
      out.push({ t: "text", v: rest });
      return out;
    }
    if (m.index > 0) out.push({ t: "text", v: rest.slice(0, m.index) });
    if (m[2] !== undefined) {
      out.push({ t: "bold", c: parseInline(m[2]) });
    } else if (m[4] !== undefined) {
      out.push({ t: "italic", c: parseInline(m[4]) });
    } else if (m[6] !== undefined) {
      out.push({ t: "bold", c: parseInline(m[6]) });
    } else if (m[8] !== undefined) {
      out.push({ t: "code", v: m[8] });
    } else if (m[10] !== undefined) {
      out.push({ t: "strike", c: parseInline(m[10]) });
    } else if (m[12] !== undefined && m[13] !== undefined) {
      out.push({ t: "link", text: m[12], href: m[13] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// ── the block parser ────────────────────────────────────────────────────────

const HR_RE = /^ {0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_RE = /^```\s*([A-Za-z0-9_+-]*)\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}[-\s|:]*$/;

/** A table row split into cell texts ("| a | b |" → ["a","b"]). */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** Parse the whole source into blocks (blank-line separated). */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank → skip.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code.
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const lang = fence[1] === "" ? null : fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      // Skip the closing fence (or run off the end — an unterminated fence
      // still renders what arrived; streaming-friendly).
      if (i < lines.length) i += 1;
      blocks.push({ t: "code", lang, lines: body });
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = heading[1].length as 1 | 2 | 3 | 4;
      blocks.push({ t: "heading", level, inlines: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    // Blockquote (consecutive > lines fold).
    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (q === null) break;
        body.push(q[1]);
        i += 1;
      }
      blocks.push({ t: "quote", inlines: parseInline(body.join(" ")) });
      continue;
    }

    // Table (header + separator + rows).
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ t: "table", header, rows });
      continue;
    }

    // Lists (unordered or ordered, ONE nesting level via indentation).
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul !== null || ol !== null) {
      const ordered = ul === null;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? OL_RE.exec(l) : UL_RE.exec(l);
        const other = ordered ? UL_RE.exec(l) : OL_RE.exec(l);
        if (m !== null && (m[1] === "" || items.length === 0)) {
          items.push({ inlines: parseInline(m[2].trim()), sub: null });
          i += 1;
          continue;
        }
        // A nested line (indented, either marker kind) attaches to the last item.
        const nested = UL_RE.exec(l) ?? OL_RE.exec(l);
        if (nested !== null && nested[1] !== "" && items.length > 0) {
          const last = items[items.length - 1];
          last.sub = parseInline(nested[2].trim());
          i += 1;
          continue;
        }
        if (other === null && m === null && nested === null) break;
        if (m === null && nested === null) break;
        if (m === null) break;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }

    // Paragraph — consecutive non-blank, non-structural lines fold.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === "" ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        HR_RE.test(l) ||
        QUOTE_RE.test(l) ||
        UL_RE.test(l) ||
        OL_RE.test(l)
      ) {
        break;
      }
      para.push(l);
      i += 1;
    }
    blocks.push({ t: "paragraph", inlines: parseInline(para.join("\n")) });
  }

  return blocks;
}
