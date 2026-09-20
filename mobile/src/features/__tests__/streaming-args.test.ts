/**
 * streaming-args.test.ts — R114-d: the tolerant PARTIAL-JSON extractor the
 * live write preview runs on a running tool card's accumulated raw (the
 * desktop's src/components/project-chat/streaming-args.ts semantics,
 * phone-side). The raw is a PREFIX of valid JSON — it can end mid-string,
 * mid-escape, even mid-key; the scanner must return whatever prefix it
 * decoded, never throw. Zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import { extractStringArg, extractWritePreview } from "../streaming-args";

describe("extractStringArg — the tolerant scanner", () => {
  it("extracts a COMPLETE string argument", () => {
    const raw = '{"path":"src/a.ts","content":"hello"}';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "src/a.ts" });
    expect(extractStringArg(raw, "content")).toEqual({ found: true, value: "hello" });
  });

  it("extracts a PARTIAL value (the raw ends mid-string — the live case)", () => {
    expect(extractStringArg('{"path":"src/a.ts","content":"docum', "content")).toEqual({
      found: true,
      value: "docum",
    });
  });

  it("decodes JSON escapes as they complete; a trailing lone backslash contributes nothing", () => {
    expect(extractStringArg('{"path":"a\\nb\\tc"}', "path")).toEqual({ found: true, value: "a\nb\tc" });
    expect(extractStringArg('{"path":"quote:\\""', "path")).toEqual({ found: true, value: 'quote:"' });
    expect(extractStringArg('{"path":"back\\', "path")).toEqual({ found: true, value: "back" });
    expect(extractStringArg('{"path":"uni\\u00e9"', "path")).toEqual({ found: true, value: "uni\u00e9" });
    // A SHORT \u run means the raw ends inside the sequence — nothing decodes yet.
    expect(extractStringArg('{"path":"uni\\u00', "path")).toEqual({ found: true, value: "uni" });
    // An INVALID full-length hex run is tolerated as a literal "u".
    expect(extractStringArg('{"path":"uni\\uZZZZ"', "path")).toEqual({ found: true, value: "uniuZZZZ" });
  });

  it("skips key-text occurrences inside OTHER string values (the first quoted key wins)", () => {
    // A JSON file being written embeds a nested "path": — the TOP-LEVEL
    // argument (which precedes the content) is the one that resolves.
    const raw = '{"path":"outer.ts","content":"{\\"path\\":\\"inner.md\\",\\"x\\":1}"}';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "outer.ts" });
    // A quoted "key" NOT followed by `: "…` is not an argument at all.
    expect(extractStringArg('{"note":"the word \\"path\\" appears here","x":1}', "path")).toEqual({
      found: false,
      value: "",
    });
    // Non-string values are skipped too.
    expect(extractStringArg('{"path":42,"content":"x"}', "path")).toEqual({ found: false, value: "" });
  });

  it("tolerates whitespace between the key, the colon, and the value", () => {
    expect(extractStringArg('{ "path" : "a.ts" }', "path")).toEqual({ found: true, value: "a.ts" });
  });

  it("not found → found:false, and never throws on junk", () => {
    expect(extractStringArg("{}", "path")).toEqual({ found: false, value: "" });
    expect(extractStringArg("", "path")).toEqual({ found: false, value: "" });
    expect(extractStringArg("not json at all", "path")).toEqual({ found: false, value: "" });
    expect(extractStringArg('{"content":', "content")).toEqual({ found: false, value: "" });
  });

  it("answers the file_path spelling the spec named alongside the tools' real path key", () => {
    expect(extractStringArg('{"file_path":"b.ts","content":"x"}', "file_path")).toEqual({
      found: true,
      value: "b.ts",
    });
    expect(extractStringArg('{"name":"deep-research"}', "name")).toEqual({
      found: true,
      value: "deep-research",
    });
  });
});

describe("extractWritePreview — the write card's distilled view", () => {
  it("path + content-so-far + the char count, from a PARTIAL raw", () => {
    const preview = extractWritePreview('{"path":"src/app.ts","content":"import Reac');
    expect(preview.path).toBe("src/app.ts");
    expect(preview.content).toBe("import Reac");
    expect(preview.chars).toBe(11);
  });

  it("edit_file's newString rides when content is absent", () => {
    const preview = extractWritePreview('{"path":"a.ts","oldString":"x","newString":"y}');
    expect(preview.path).toBe("a.ts");
    // The string is still OPEN — the partial value is "y}" (the raw's own
    // tail; the scanner keeps everything decoded so far, braces included).
    expect(preview.content).toBe("y}");
    expect(preview.chars).toBe(2);
  });

  it("an empty/partial raw answers honestly (no path yet, zero chars)", () => {
    expect(extractWritePreview("")).toEqual({ path: null, content: "", chars: 0 });
    expect(extractWritePreview('{"path":')).toEqual({ path: null, content: "", chars: 0 });
    // The file_path spelling resolves when path does not.
    expect(extractWritePreview('{"file_path":"b.ts","content":"hi"}').path).toBe("b.ts");
  });
});
