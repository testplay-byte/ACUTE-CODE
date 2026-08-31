/**
 * ROUND-58 (R58-cf) tests — the tolerant incremental JSON-string-arg extractor
 * behind the live file-write preview. The raw it parses is a PREFIX of the
 * tool call's JSON arguments (concatenated tool-input-delta frames), so every
 * "ends mid-…" case below is the NORM the extractor is built for, not an edge.
 */
import { describe, expect, it } from "vitest";
import { extractStringArg } from "./streaming-args";

describe("extractStringArg (ROUND-58 R58-cf)", () => {
  it("not found → { found: false, value: \"\" }", () => {
    expect(extractStringArg("", "content")).toEqual({ found: false, value: "" });
    expect(extractStringArg('{"path":"a.txt"}', "content")).toEqual({
      found: false,
      value: "",
    });
  });

  it("complete key/value pair decodes", () => {
    const raw = '{"path":"src/app.ts","content":"hello"}';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "src/app.ts" });
    expect(extractStringArg(raw, "content")).toEqual({ found: true, value: "hello" });
  });

  it("PARTIAL value (raw ends mid-string) returns the decoded prefix", () => {
    // The exact live-preview shape: the model is still generating the content.
    const raw = '{"path":"a.txt","content":"<!DOCTYPE html>\\n<ht';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "a.txt" });
    expect(extractStringArg(raw, "content")).toEqual({
      found: true,
      value: "<!DOCTYPE html>\n<ht",
    });
  });

  it("raw ends right after the opening quote → empty prefix, found", () => {
    expect(extractStringArg('{"path":"', "path")).toEqual({ found: true, value: "" });
    expect(extractStringArg('{"content":"', "content")).toEqual({ found: true, value: "" });
  });

  it("decodes every JSON escape the preview can meet", () => {
    const raw =
      '{"content":"line1\\nline2\\ttab\\rcr \\"quoted\\" back\\\\slash sla\\//\\b bel\\u0041 \\u00e9"}';
    expect(extractStringArg(raw, "content")).toEqual({
      found: true,
      value: 'line1\nline2\ttab\rcr "quoted" back\\slash sla//\b belA é',
    });
  });

  it("a dangling backslash at the end of the raw contributes nothing (next delta completes it)", () => {
    expect(extractStringArg('{"content":"abc\\', "content")).toEqual({
      found: true,
      value: "abc",
    });
  });

  it("an INCOMPLETE \\u escape (raw ends inside the hex run) decodes to nothing yet", () => {
    // raw ends inside \u00 — the next delta completes the escape; the
    // extractor is stateless and re-scans the whole raw on every call, so the
    // transient value is simply the prefix without the pending escape.
    expect(extractStringArg('{"content":"abc\\u00', "content")).toEqual({
      found: true,
      value: "abc",
    });
    expect(extractStringArg('{"content":"\\u004', "content")).toEqual({
      found: true,
      value: "",
    });
    // Completed surrogate pair decodes to the two code units (renders as one glyph).
    expect(extractStringArg('{"content":"\\ud83d\\ude00"}', "content")).toEqual({
      found: true,
      value: "😀",
    });
  });

  it("edit_file keys: newString / oldString both resolve; newlines inside values stay", () => {
    const raw =
      '{"path":"src/a.ts","oldString":"const a = 1;\\n","newString":"const a = 2;\\nconst b = 3;"}';
    expect(extractStringArg(raw, "oldString")).toEqual({ found: true, value: "const a = 1;\n" });
    expect(extractStringArg(raw, "newString")).toEqual({
      found: true,
      value: "const a = 2;\nconst b = 3;",
    });
  });

  it("whitespace between key, colon and value is tolerated", () => {
    const raw = '{ "path" : "dir/file.ts" ,\n  "content" : "x" }';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "dir/file.ts" });
    expect(extractStringArg(raw, "content")).toEqual({ found: true, value: "x" });
  });

  it("the FIRST quoted key: value occurrence wins (content embedding a nested \"path\" loses)", () => {
    // A JSON file being WRITTEN whose body itself contains "path" — the
    // top-level path (first occurrence, preceding content) wins.
    const raw =
      '{"path":"out/config.json","content":"{ \\"path\\": \\"nested\\" }"}';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "out/config.json" });
  });

  it("a quoted key NOT followed by a string value is skipped, later occurrences still match", () => {
    // "path" as a bare word inside a string value, then the real key later.
    const raw = '{"note":"use the \\"path\\" key","path":"real.ts"}';
    expect(extractStringArg(raw, "path")).toEqual({ found: true, value: "real.ts" });
  });

  it("key-like text inside a string value but with no following colon is skipped", () => {
    const raw = '{"m":"content is king","content":"winner"}';
    expect(extractStringArg(raw, "content")).toEqual({ found: true, value: "winner" });
  });
});
