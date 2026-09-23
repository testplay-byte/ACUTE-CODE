/**
 * streaming-args.ts — R114-d: the tolerant PARTIAL-JSON argument extractor
 * for the phone's LIVE WRITE PREVIEW (the desktop's
 * src/components/project-chat/streaming-args.ts, ported verbatim in spirit —
 * the owner: "writing a file was not shown properly on mobile while PC
 * streamed it"). The runtime streams a tool call's JSON arguments as
 * tool-input-start / tool-input-delta frames while the model generates them
 * (features/sessions.ts accumulates the raw on the running tool card); this
 * module pulls a SINGLE string argument's value out of that raw PREFIX —
 * no JSON.parse anywhere (the raw is a prefix of valid JSON: it can end
 * mid-string, mid-escape, even mid-key; a parse-based approach would throw
 * on every delta).
 *
 * Design constraints (the desktop's, carried over):
 *  - TOLERANT by construction — a throw-free scanner that walks the raw once
 *    and returns whatever prefix it decoded.
 *  - The FIRST quoted occurrence of the key wins: `path` precedes `content`
 *    in write_file/edit_file arguments, so even a huge content value that
 *    embeds a nested `"path":` (a JSON file being written!) resolves to the
 *    top-level argument in practice.
 *  - The spec's `file_path` spelling is tolerated alongside the tools' real
 *    `path` key (the extractor answers whichever the call carried — the
 *    truth wins over either vocabulary).
 *
 * ROUND-123 (R123-W-m — the owner's "no tool calls were shown to me" round):
 * the WEB families join the classification. browser_control / web_search /
 * web_fetch are tools the agent ACTUALLY runs, and the R119 generic row
 * rendered their raw "action: navigate, url: …" key:value dump verbatim —
 * the shapeless rendering the owner reported. The key union grows the
 * families' own argument names (`action`, `query`, `url`) so the live
 * extractor answers an in-flight browser navigation's URL exactly the way
 * it answers an in-flight write's path; the row/hint grammar that consumes
 * them lives in features/turn-block.ts.
 *
 * Pure TypeScript — zero React Native (unit-tested directly).
 */

/** The argument keys the live write preview + the compact tool rows read (a
 * closed set — the tools' real schemas, plus the `file_path` spelling the
 * R114-d spec named, the skills' `name`, and the R123-W-m web families'
 * `action`/`query`/`url`). */
export type StreamingArgKey =
  | "action"
  | "content"
  | "file_path"
  | "name"
  | "newString"
  | "oldString"
  | "path"
  | "query"
  | "url";

/** Whitespace tolerated between a key and its value (JSON's own set). */
const JSON_WHITESPACE = /[ \t\r\n]/;

/**
 * Extract one string argument from a (possibly PARTIAL) tool-args JSON raw.
 *
 * Locates `"<key>"` followed by optional whitespace, `:`, optional
 * whitespace, then an opening `"`. From there it walks the raw string
 * decoding JSON escapes (\n \t \r \" \\ \/ \b \f \uXXXX) until the closing
 * unescaped quote (complete) or the end of the raw (partial — the
 * live-preview case). Returns the decoded prefix.
 *
 * A candidate occurrence that isn't followed by `: "…` (e.g. the key text
 * appears inside some OTHER string's value) is skipped and the search
 * continues — a quoted `"key"` immediately introducing a string value is
 * the only shape accepted.
 *
 * Not found → { found: false, value: "" }.
 */
export function extractStringArg(
  raw: string,
  key: StreamingArgKey,
): { found: boolean; value: string } {
  const needle = `"${key}"`;
  let searchFrom = 0;
  for (;;) {
    const keyIdx = raw.indexOf(needle, searchFrom);
    if (keyIdx === -1) return { found: false, value: "" };
    searchFrom = keyIdx + 1;

    let i = keyIdx + needle.length;
    while (i < raw.length && JSON_WHITESPACE.test(raw[i])) i += 1;
    if (raw[i] !== ":") continue; // not a key: value pair — keep searching
    i += 1;
    while (i < raw.length && JSON_WHITESPACE.test(raw[i])) i += 1;
    if (raw[i] !== '"') continue; // value isn't a string — keep searching
    i += 1;

    // Walk the string value, decoding escapes as they complete. The loop
    // ends at the closing unescaped quote (complete value) or at the end of
    // the raw (PARTIAL value — the live-preview case).
    let out = "";
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch !== "\\") {
        if (ch === '"') return { found: true, value: out }; // closed cleanly
        out += ch;
        continue;
      }
      // Escape sequence — a trailing lone backslash (raw ends mid-escape)
      // contributes nothing: the next delta completes it.
      const next = raw[i + 1];
      if (next === undefined) return { found: true, value: out };
      i += 1;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "u": {
          // \uXXXX — a SHORT hex run means the raw ends inside the sequence
          // (nothing decodes yet; the next delta completes it). A
          // full-length INVALID hex run is tolerated as a literal "u" and
          // scanning continues — the preview must never throw.
          const hex = raw.slice(i + 1, i + 5);
          if (hex.length < 4) return { found: true, value: out };
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += "u";
            break;
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          // Unknown escape — keep the character literally (tolerance over
          // strictness; the preview must never throw).
          out += next;
      }
    }
    return { found: true, value: out }; // end of raw — partial value
  }
}

/** The write tools' real names (the per-tool card dispatch keys). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/** The terminal tools (the mono command line + the streamed tail). */
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["run_command", "bash"]);

/** The compact-read tools (one-line rows; the args dump stays collapsed). */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read_skill", "search_skills", "read_file"]);

/** R123-W-m — the WEB pair (web_search's `query`, web_fetch's `url`): the
 * honest one-line target family the owner's reference screenshots show as
 * first-class rows ("Searched …" / "Fetched …" on the PC). */
export const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/** R123-W-m — the EMBEDDED BROWSER family (browser_control): the row's target
 * is the call's own `action` (+ its `url` when the action carries one) —
 * never the raw "action: navigate, url: …" key:value dump. */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set(["browser_control"]);

/**
 * The LIVE WRITE PREVIEW's distilled view of a running/staged write call:
 * the file path (the `path` arg — the `file_path` spelling tolerated), the
 * content-so-far (write_file's `content`, edit_file's `newString`), and the
 * char count (the content's own length — the counter the card renders).
 * Pure — the card calls it per render off the accumulated raw.
 */
export function extractWritePreview(raw: string): {
  path: string | null;
  content: string;
  chars: number;
} {
  const pathArg = extractStringArg(raw, "path");
  const filePathArg = extractStringArg(raw, "file_path");
  const path = pathArg.found ? pathArg.value : filePathArg.found ? filePathArg.value : null;
  const contentArg = extractStringArg(raw, "content");
  const content = contentArg.found
    ? contentArg.value
    : extractStringArg(raw, "newString").value;
  return { path, content, chars: content.length };
}
