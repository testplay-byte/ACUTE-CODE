/**
 * ROUND-58 (R58-cf, owner: "no live preview while the agent WRITES files — the
 * diff only appears after the tool completes"): the engine now streams a tool
 * call's JSON ARGUMENTS as `tool-input-start` / `tool-input-delta` frames while
 * the model generates them. The store concatenates the raw JSON fragments
 * (e.g. for write_file the raw grows like
 * `{"path":"a.txt","content":"<!DOCTYPE…`). This module extracts a SINGLE
 * string argument's value out of that PARTIAL raw JSON — enough to render a
 * live write preview (path + content-so-far) without a full JSON.parse, which
 * is impossible until the model closes the string (and often the whole tool
 * call) anyway.
 *
 * Design constraints:
 *  - TOLERANT by construction: the raw is a PREFIX of valid JSON — it can end
 *    mid-string, mid-escape, even mid-key. A throw-free scanner that walks the
 *    raw once and returns whatever prefix it decoded is the whole point.
 *  - No JSON.parse anywhere: a partial document + escaped content would make
 *    any parse-based approach throw on every delta.
 *  - The FIRST quoted occurrence of the key wins: `path` precedes `content`
 *    in write_file/edit_file arguments, so even a huge content value that
 *    embeds a nested `"path":` (a JSON file being written!) resolves to the
 *    top-level argument in practice.
 */

/**
 * The argument keys the live write preview reads. Deliberately a closed
 * union (the extractor is generic over nothing — these are the only shapes
 * the DIFF tools emit).
 */
export type StreamingArgKey = "content" | "newString" | "path" | "oldString";

/** Whitespace tolerated between a key and its value (JSON's own set). */
const JSON_WHITESPACE = /[ \t\r\n]/;

/**
 * Extract one string argument from a (possibly PARTIAL) tool-args JSON raw.
 *
 * Locates `"<key>"` followed by optional whitespace, `:`, optional
 * whitespace, then an opening `"`. From there it walks the raw string
 * decoding JSON escapes (\n \t \r \" \\ \/ \b \f \uXXXX) until the closing
 * unescaped quote (complete) or the end of the raw (partial — that is the
 * live-preview case). Returns the decoded prefix.
 *
 * A candidate occurrence that isn't followed by `: "…` (e.g. the key text
 * appears inside some OTHER string's value) is skipped and the search
 * continues — a quoted `"key"` immediately introducing a string value is the
 * only shape accepted.
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

    // Walk the string value, decoding escapes as they complete. The loop ends
    // at the closing unescaped quote (complete value) or at the end of the
    // raw (PARTIAL value — the live-preview case).
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
          // (nothing decodes yet; the next delta completes it). A full-length
          // INVALID hex run is tolerated as a literal "u" and scanning
          // continues — the preview must never throw.
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
