/**
 * markdown.test.ts — the pure parser's contract (R109: "the responses are
 * not formatted, some responses are not made bold" — this pins the fix).
 */

import { describe, expect, it } from "@jest/globals";

import { TYPE_BODY, TYPE_HEADING, TYPE_TITLE } from "@/design/tokens";
import { headingTier, parseInline, parseMarkdown } from "../markdown";

describe("parseInline", () => {
  it("plain text passes through as one token", () => {
    expect(parseInline("hello world")).toEqual([{ t: "text", v: "hello world" }]);
  });

  it("bold via ** and __", () => {
    expect(parseInline("a **b** c")).toEqual([
      { t: "text", v: "a " },
      { t: "bold", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " c" },
    ]);
    expect(parseInline("x __y__")).toEqual([
      { t: "text", v: "x " },
      { t: "bold", c: [{ t: "text", v: "y" }] },
    ]);
  });

  it("italic via single *", () => {
    expect(parseInline("a *b* c")).toEqual([
      { t: "text", v: "a " },
      { t: "italic", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " c" },
    ]);
  });

  it("inline code", () => {
    expect(parseInline("run `bun test` now")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "bun test" },
      { t: "text", v: " now" },
    ]);
  });

  it("links carry text + href", () => {
    expect(parseInline("see [the docs](https://example.com)")).toEqual([
      { t: "text", v: "see " },
      { t: "link", text: "the docs", href: "https://example.com" },
    ]);
  });

  it("strike-through", () => {
    expect(parseInline("~~old~~ new")).toEqual([
      { t: "strike", c: [{ t: "text", v: "old" }] },
      { t: "text", v: " new" },
    ]);
  });

  it("mixed markers in one line", () => {
    const out = parseInline("**bold** and `code` and *it*");
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ t: "bold", c: [{ t: "text", v: "bold" }] });
    expect(out[2]).toEqual({ t: "code", v: "code" });
    expect(out[4]).toEqual({ t: "italic", c: [{ t: "text", v: "it" }] });
  });

  it("unterminated markers stay literal text (streaming-safe)", () => {
    expect(parseInline("a **bo")).toEqual([{ t: "text", v: "a **bo" }]);
  });
});

describe("parseMarkdown blocks", () => {
  it("paragraphs fold consecutive lines", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ t: "paragraph", inlines: [{ t: "text", v: "one\ntwo" }] });
    expect(blocks[1]?.t).toBe("paragraph");
  });

  it("fenced code blocks carry their language and body verbatim", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\nconst y = 2;\n```");
    expect(blocks).toEqual([{ t: "code", lang: "ts", lines: ["const x = 1;", "const y = 2;"] }]);
  });

  it("an UNTERMINATED fence still renders its body (live streaming)", () => {
    const blocks = parseMarkdown("```\npartial code");
    expect(blocks[0]).toEqual({ t: "code", lang: null, lines: ["partial code"] });
  });

  it("headings level 1-4 with inline parsing", () => {
    const blocks = parseMarkdown("# Title\n## Sub **bold**\n### Three\n#### Four");
    expect(blocks.map((b) => (b.t === "heading" ? b.level : b.t))).toEqual([1, 2, 3, 4]);
    const second = blocks[1];
    if (second?.t === "heading") {
      // "Sub **bold**" → [text "Sub ", bold]
      expect(second.inlines[0]).toEqual({ t: "text", v: "Sub " });
      expect(second.inlines[1]).toEqual({ t: "bold", c: [{ t: "text", v: "bold" }] });
    } else {
      expect(second?.t).toBe("heading");
    }
  });

  it("unordered lists with one nesting level", () => {
    const blocks = parseMarkdown("- a\n- b\n  - b.sub\n- c");
    const list = blocks[0];
    if (list?.t !== "list") {
      expect(list?.t).toBe("list");
      return;
    }
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    expect(list.items[1]?.sub).toEqual([{ t: "text", v: "b.sub" }]);
  });

  it("ordered lists", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    const list = blocks[0];
    if (list?.t !== "list") {
      expect(list?.t).toBe("list");
      return;
    }
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
  });

  it("blockquotes fold consecutive lines", () => {
    const blocks = parseMarkdown("> quoted line\n> another quoted");
    expect(blocks).toEqual([{ t: "quote", inlines: [{ t: "text", v: "quoted line another quoted" }] }]);
  });

  it("tables parse header + rows", () => {
    const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    const table = blocks[0];
    if (table?.t !== "table") {
      expect(table?.t).toBe("table");
      return;
    }
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]?.[1]).toEqual([{ t: "text", v: "4" }]);
  });

  it("horizontal rules", () => {
    expect(parseMarkdown("---")[0]?.t).toBe("hr");
    expect(parseMarkdown("***")[0]?.t).toBe("hr");
  });

  it("a realistic model answer parses into the expected shape", () => {
    const src = [
      "## Plan",
      "",
      "I'll **start** with the `tokens.ts` file, then:",
      "",
      "- rewrite the theme table",
      "- keep the flat aesthetic",
      "  - but add clay shadows",
      "",
      "```ts",
      "export const RADIUS = 20;",
      "```",
      "",
      "> The owner said: make it beautiful.",
      "",
      "Done — see [the design](https://example.com).",
    ].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks.map((b) => b.t)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "quote",
      "paragraph",
    ]);
  });

  it("CRLF input normalizes", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
  });
});

// ── R120-CM: the heading tier recipe (§1 item 41 — "no proper headings") ────

describe("headingTier — the markdown heading → house Type ladder table", () => {
  it("H1 is the TITLE tier (20/700 — the document's one headline; Display 28 stays wizard-only)", () => {
    expect(headingTier(1)).toEqual({ size: TYPE_TITLE, weight: 700 });
    expect(TYPE_TITLE).toBe(20);
  });

  it("H2 is the HEADING tier at full title weight (16/700)", () => {
    expect(headingTier(2)).toEqual({ size: TYPE_HEADING, weight: 700 });
    expect(TYPE_HEADING).toBe(16);
  });

  it("H3 is the HEADING tier one weight down (16/600 — the ladder's row-title weight, a visible step without a rogue size)", () => {
    expect(headingTier(3)).toEqual({ size: TYPE_HEADING, weight: 600 });
  });

  it("H4 is the BODYSTRONG tier (15/600 — the run-in heading; never plain-body weight again)", () => {
    expect(headingTier(4)).toEqual({ size: TYPE_BODY, weight: 600 });
    expect(TYPE_BODY).toBe(15);
  });

  it("every level steps DOWN or stays — the hierarchy is strictly visible: H1 > H2 ≥ H3 > H4", () => {
    const tiers = [headingTier(1), headingTier(2), headingTier(3), headingTier(4)];
    for (let i = 1; i < tiers.length; i += 1) {
      const prev = tiers[i - 1];
      const curr = tiers[i];
      expect(prev !== undefined && curr !== undefined).toBe(true);
      if (prev === undefined || curr === undefined) continue;
      // size never grows downward, and size+weight together strictly step down
      expect(curr.size).toBeLessThanOrEqual(prev.size);
      expect(curr.size * 10 + curr.weight).toBeLessThan(prev.size * 10 + prev.weight);
    }
  });

  it("the parser and the recipe agree on the vocabulary — levels 1-4 are the only headings", () => {
    const blocks = parseMarkdown("# a\n## b\n### c\n#### d\n");
    const levels = blocks.filter((b) => b.t === "heading").map((b) => (b.t === "heading" ? b.level : 0));
    expect(levels).toEqual([1, 2, 3, 4]);
    for (const level of levels) {
      expect(() => headingTier(level as 1 | 2 | 3 | 4)).not.toThrow();
    }
  });
});
