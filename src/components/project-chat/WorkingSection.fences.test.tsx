// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { splitThinkingFences } from "./WorkingSection";
import { normalizeLang, highlightCode } from "../../lib/highlight";

/**
 * ROUND-97 (R97-F) — the thinking area's code blocks.
 *
 * The owner: "in the thinking, if it shows a code block, then that code block
 * should clearly be highlighted. It should clearly be formatted in colors and
 * it should be properly shown."
 *
 * Pins:
 *  · splitThinkingFences: prose/code alternation, the language capture, the
 *    UNCLOSED-fence streaming rule (a partial trailing fence stays prose so
 *    the block never pops in and out mid-stream), and the empty input.
 *  · normalizeLang: the alias table + the unknown-language fallback.
 *  · highlightCode: real token spans for a known language; null for unknown
 *    languages and pathological inputs (never a crash).
 */
describe("splitThinkingFences (R97-F)", () => {
  it("splits prose and CLOSED fences, capturing the language", () => {
    const parts = splitThinkingFences(
      "I will inspect the file first.\n```ts\nconst x: number = 1;\n```\nThen I will edit it.",
    );
    expect(parts).toEqual([
      { kind: "text", text: "I will inspect the file first." },
      { kind: "code", lang: "ts", code: "const x: number = 1;" },
      { kind: "text", text: "Then I will edit it." },
    ]);
  });

  it("an UNCLOSED trailing fence stays PROSE (the streaming rule)", () => {
    const parts = splitThinkingFences("analysis so far\n```python\ndef part");
    expect(parts).toEqual([{ kind: "text", text: "analysis so far\n```python\ndef part" }]);
  });

  it("multiple fences alternate correctly; a languageless fence works", () => {
    const parts = splitThinkingFences("a\n```\nplain\n```\nb\n```js\nx()\n```\nc");
    expect(parts).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "", code: "plain" },
      { kind: "text", text: "b" },
      { kind: "code", lang: "js", code: "x()" },
      { kind: "text", text: "c" },
    ]);
  });

  it("empty input splits to nothing", () => {
    expect(splitThinkingFences("")).toEqual([]);
  });
});

describe("the highlighter (R97-F)", () => {
  it("normalizeLang maps the aliases and rejects the unknown", () => {
    expect(normalizeLang("ts")).toBe("typescript");
    expect(normalizeLang("py")).toBe("python");
    expect(normalizeLang("sh")).toBe("bash");
    expect(normalizeLang("yml")).toBe("yaml");
    expect(normalizeLang("TS ")).toBe("typescript");
    expect(normalizeLang("")).toBe("none");
    expect(normalizeLang("not-a-language")).toBe("none");
  });

  it("highlightCode tokenizes a known language into token spans", () => {
    const html = highlightCode("const x = 1;", "ts");
    expect(html).not.toBeNull();
    expect(html).toContain("token keyword");
    expect(html).toContain("token number");
  });

  it("an unknown language returns null (the plain-lines fallback)", () => {
    expect(highlightCode("anything", "not-a-language")).toBeNull();
    expect(highlightCode("anything", undefined)).toBeNull();
    expect(highlightCode("anything", "")).toBeNull();
  });

  it("a pathological input never crashes (null, not a throw)", () => {
    // A crafted input that could upset a regex grammar — the try/catch owns it.
    const weird = "```".repeat(50) + "\n".repeat(100) + "([)]{";
    expect(() => highlightCode(weird, "regex")).not.toThrow();
  });
});
