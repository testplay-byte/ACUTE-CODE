/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): MARKDOWN-LITE as a streaming state
 * machine — incremental ONLY (each text-delta writes its own output the
 * moment it is safe; nothing is ever re-rendered or re-serialized).
 *
 * Supported grammar (the design's exact set):
 *   · `**bold**`      → SGR bold
 *   · `*italic*`      → SGR italic (a `*` followed by whitespace is a
 *                       literal bullet — never a toggle)
 *   · `` `code` ``    → accent-tinted inline code
 *   · ``` fences      → indented dim block (fence markers consumed)
 *   · `##` headings   → bold accent, whole line (`#`…`######` + space)
 *
 * The HOLDBACK discipline makes markers-split-across-deltas safe: any tail
 * that could be an incomplete marker (trailing `*` / `` ` `` / `#` runs, a
 * heading without its newline) stays buffered until the next delta or
 * `finish()` resolves it. A persistent `atLineBoundary` flag carries the
 * line-start context across those holds (a held `#` from mid-line must
 * never look like a heading). Style wraps are per-segment — an unclosed
 * `**` at end-of-turn can never leak an unbalanced SGR sequence.
 */
import { accentCode, boldAccent, type ColorKit } from "../color.js";

export interface MarkdownRenderer {
  /** Push one text delta → the styled output safe to write NOW. */
  push(delta: string): string;
  /** Flush at end-of-turn: resolve every holdback with final semantics. */
  finish(): string;
}

/** Render a whole sequence of deltas (the test/drive-by helper). */
export function renderTextDeltas(deltas: readonly string[], kit: ColorKit, plain = false): string {
  const renderer = createMarkdownRenderer(kit, plain);
  let out = "";
  for (const delta of deltas) out += renderer.push(delta);
  return out + renderer.finish();
}

/** Create the machine. `plain` still consumes markers (structure only). */
export function createMarkdownRenderer(kit: ColorKit, plain = false): MarkdownRenderer {
  let pending = "";
  let inFence = false;
  /** The OPENING fence's info-string line (```js … ) is marker, not
   * content — consumed silently through its newline (or end-of-turn). */
  let fenceInfo = false;
  let atLineBoundary = true; // pending starts on a stream line boundary
  const style = { bold: false, italic: false, code: false };

  const wrap = (text: string): string => {
    if (plain || text === "") return text;
    let out = text;
    if (style.code) out = accentCode(kit, out);
    if (style.bold) out = kit.bold(out);
    if (style.italic) out = kit.enabled ? `\x1b[3m${out}\x1b[23m` : out;
    return out;
  };

  const consume = (raw: string): string => {
    if (raw !== "") atLineBoundary = raw.endsWith("\n");
    return wrap(raw);
  };

  const isMarkerChar = (ch: string): boolean => ch === "*" || ch === "`" || ch === "#";

  /** Line-start test INSIDE pending (position 0 = the boundary flag). */
  const lineStartAt = (text: string, i: number): boolean =>
    i === 0 ? atLineBoundary : text[i - 1] === "\n";

  const countHeadingHashes = (text: string, i: number): number => {
    let n = 0;
    while (n < 6 && text[i + n] === "#") n++;
    return n;
  };

  const findFenceToken = (text: string): number => {
    for (let i = 0; i < text.length; i++) {
      if (lineStartAt(text, i) && text.startsWith("```", i)) return i;
    }
    return -1;
  };

  /** In fence mode: a trailing PURE-backtick run that starts on a line
   * boundary could still grow into the closing fence — hold it (final
   * decides immediately). Any other tail is plain content and flows. */
  const fenceHoldback = (text: string): number => {
    let n = 0;
    while (n < text.length && text[text.length - 1 - n] === "`") n++;
    if (n === 0) return 0;
    const start = text.length - n;
    const startsAtBoundary = start === 0 ? atLineBoundary : text[start - 1] === "\n";
    return startsAtBoundary ? n : 0;
  };

  const drain = (final: boolean): string => {
    let out = "";
    while (pending !== "") {
      if (inFence) {
        if (fenceInfo) {
          // Consume the info-string line silently — its newline included
          // (a fence opening at a line boundary starts content ON the next).
          const nl = pending.indexOf("\n");
          if (nl < 0) {
            if (final) {
              pending = "";
              fenceInfo = false;
            }
            return out; // hold the whole incomplete info line
          }
          pending = pending.slice(nl + 1);
          fenceInfo = false;
          atLineBoundary = true;
          continue;
        }
        const closeAt = findFenceToken(pending);
        if (closeAt >= 0) {
          out += dimIndent(kit, plain, pending.slice(0, closeAt));
          pending = pending.slice(closeAt + 3);
          const hadNewline = pending.startsWith("\n");
          if (hadNewline) pending = pending.slice(1);
          atLineBoundary = hadNewline;
          inFence = false;
          continue;
        }
        // No close yet: emit content, holding the maybe-fence tail.
        const hold = final ? 0 : fenceHoldback(pending);
        const cut = pending.length - hold;
        out += dimIndent(kit, plain, pending.slice(0, cut));
        const consumed = pending.slice(0, cut);
        pending = pending.slice(cut);
        if (consumed !== "") atLineBoundary = consumed.endsWith("\n");
        return out;
      }

      // Normal mode: find the next marker char. Inside an inline code span
      // the ONLY marker is the closing backtick — `*`/`#` are content
      // (markdown's rule: code wins inside its span, `**x**` is code text
      // — never a bold toggle), and the content flows as ONE segment so
      // the accent wrap stays contiguous.
      const markerHere = (i: number): boolean =>
        style.code ? pending[i] === "`" : isMarkerChar(pending[i]);
      let idx = -1;
      for (let i = 0; i < pending.length; i++) {
        if (markerHere(i)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        // No marker at all — flow everything (minus a trailing marker-run
        // holdback, which cannot exist here: no marker chars present).
        out += consume(pending);
        pending = "";
        return out;
      }
      // A trailing marker RUN at the end of pending is unresolved — hold it
      // (unless final, where every marker must be decided NOW).
      const runEnd = idx;
      let runLen = 0;
      while (runEnd + runLen < pending.length && isMarkerChar(pending[runEnd + runLen])) runLen++;
      if (!final && idx + runLen === pending.length) {
        out += consume(pending.slice(0, idx));
        pending = pending.slice(idx);
        return out;
      }

      const ch = pending[idx];
      if (ch === "`") {
        if (pending.startsWith("```", idx)) {
          if (lineStartAt(pending, idx)) {
            out += consume(pending.slice(0, idx));
            pending = pending.slice(idx + 3);
            inFence = true;
            fenceInfo = true;
            continue;
          }
          // Mid-line triple backtick: literal (3 chars verbatim).
          out += consume(pending.slice(0, idx + 3));
          pending = pending.slice(idx + 3);
          continue;
        }
        // Inline code toggle.
        out += consume(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
        style.code = !style.code;
        continue;
      }
      if (ch === "*") {
        if (pending.startsWith("**", idx)) {
          out += consume(pending.slice(0, idx));
          pending = pending.slice(idx + 2);
          style.bold = !style.bold;
          continue;
        }
        const next = pending[idx + 1];
        if (style.italic) {
          // Any single `*` closes an open italic (markdown-lite).
          out += consume(pending.slice(0, idx));
          pending = pending.slice(idx + 1);
          style.italic = false;
          continue;
        }
        if (next !== undefined && next !== " " && next !== "\n") {
          out += consume(pending.slice(0, idx));
          pending = pending.slice(idx + 1);
          style.italic = true;
          continue;
        }
        // Literal `*` (bullet marker / stray star).
        out += consume(pending.slice(0, idx + 1));
        pending = pending.slice(idx + 1);
        continue;
      }
      // ch === "#": heading only at line start with `#`s + space.
      if (lineStartAt(pending, idx)) {
        const hashes = countHeadingHashes(pending, idx);
        if (pending[idx + hashes] === " ") {
          const lineEnd = pending.indexOf("\n", idx);
          if (lineEnd >= 0 || final) {
            const headingEnd = lineEnd >= 0 ? lineEnd : pending.length;
            out += consume(pending.slice(0, idx));
            out += renderHeading(kit, plain, pending.slice(idx, headingEnd));
            pending = pending.slice(headingEnd);
            continue;
          }
          // Heading line without its newline yet: hold the whole heading.
          out += consume(pending.slice(0, idx));
          pending = pending.slice(idx);
          return out;
        }
      }
      // Literal `#`.
      out += consume(pending.slice(0, idx + 1));
      pending = pending.slice(idx + 1);
    }
    return out;
  };

  return {
    push(delta: string): string {
      if (delta === "") return "";
      pending += delta;
      return drain(false);
    },
    finish(): string {
      return drain(true);
    },
  };
}

/** Dim + 2-space indent for fence-block content (blank lines stay blank). */
function dimIndent(kit: ColorKit, plain: boolean, text: string): string {
  if (text === "") return "";
  const indented = text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
  return plain ? indented : kit.dim(indented);
}

/** `## Heading` → bold accent line (the hash marker kept — honest structure). */
function renderHeading(kit: ColorKit, plain: boolean, headingText: string): string {
  const text = headingText.replace(/\s+$/, "");
  return plain ? text : boldAccent(kit, text);
}
