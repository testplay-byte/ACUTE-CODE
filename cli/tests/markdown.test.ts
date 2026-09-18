/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the MARKDOWN-LITE streaming state
 * machine units — the exact grammar (`**bold**`, `*italic*`, `` `code` ``
 * accent-tinted, fences → indented dim block, `##` → bold accent) plus the
 * HOLDBACK discipline: markers split across deltas never half-render.
 */
import { describe, expect, it } from "vitest";
import { colorKitFor } from "../src/color.js";
import { createMarkdownRenderer, renderTextDeltas } from "../src/render/text.js";

const KIT = colorKitFor(true, {});
const PLAIN = colorKitFor(false, {});

describe("markdown-lite grammar (single deltas)", () => {
  it("plain text flows verbatim", () => {
    expect(renderTextDeltas(["hello world"], KIT)).toBe("hello world");
  });

  it("an in-fence trailing `` tail holds, then resolves as the closing fence", () => {
    // the trailing `` cannot be decided mid-stream — it is held, then
    // resolved as the closing fence by the next delta
    const r = createMarkdownRenderer(KIT);
    const a = r.push("```\nhi\n``");
    const b = r.push("`\nafter");
    expect(a).toBe(`\x1b[2m  hi\n\x1b[22m`);
    expect(a + b + r.finish()).toBe(`\x1b[2m  hi\n\x1b[22m` + "after");
  });

  it("**bold** wraps in SGR bold", () => {
    expect(renderTextDeltas(["a **b** c"], KIT)).toBe(`a \x1b[1mb\x1b[22m c`);
  });

  it("*italic* wraps in SGR italic; a bullet `* ` is literal", () => {
    expect(renderTextDeltas(["a *b* c"], KIT)).toBe(`a \x1b[3mb\x1b[23m c`);
    expect(renderTextDeltas(["* item one\n* item two"], KIT)).toBe("* item one\n* item two");
  });

  it("`code` is accent-tinted (38;2;255;107;44)", () => {
    expect(renderTextDeltas(["run `acute status` now"], KIT)).toBe(
      `run \x1b[38;2;255;107;44macute status\x1b[39m now`,
    );
  });

  it("## headings render bold accent on the whole line (hash kept)", () => {
    const out = renderTextDeltas(["intro\n## Plan\nbody"], KIT);
    expect(out).toBe(`intro\n\x1b[1;38;2;255;107;44m## Plan\x1b[22;39m\nbody`);
  });

  it("fences consume the markers (info line included) and indent + dim the block", () => {
    const out = renderTextDeltas(["```\nconst x = 1;\n```\nafter"], KIT);
    expect(out).toBe(`\x1b[2m  const x = 1;\n\x1b[22mafter`);
  });

  it("an info-string fence (```js) consumes the info line too", () => {
    const out = renderTextDeltas(["```js\nconst x = 1;\n```"], KIT);
    expect(out).toBe(`\x1b[2m  const x = 1;\n\x1b[22m`);
  });

  it("a mid-line triple backtick is literal (only line-start opens a fence)", () => {
    expect(renderTextDeltas(["a ``` b"], KIT)).toBe("a ``` b");
  });

  it("nested-ish styling composes (bold inside code stays code-accent only)", () => {
    // code wins inside its span: `**x**` is code content, not bold
    expect(renderTextDeltas(["`**x**`"], KIT)).toBe("\x1b[38;2;255;107;44m**x**\x1b[39m");
  });
});

describe("holdback across delta boundaries (the streaming discipline)", () => {
  it("a `**` split across deltas never half-renders", () => {
    const out = renderTextDeltas(["before **", "bold** after"], KIT);
    expect(out).toBe(`before \x1b[1mbold\x1b[22m after`);
  });

  it("a heading split from its newline stays held until it resolves", () => {
    const out = renderTextDeltas(["## Hea", "ding\nx"], KIT);
    expect(out).toBe(`\x1b[1;38;2;255;107;44m## Heading\x1b[22;39m\nx`);
  });

  it("a fence opening split across deltas still opens the fence", () => {
    const out = renderTextDeltas(["code:\n``", "`\ninside\n``", "`\ndone"], KIT);
    expect(out).toBe("code:\n" + `\x1b[2m  inside\n\x1b[22m` + "done");
  });

  it("an unclosed `**` at end-of-turn resolves WITHOUT leaking SGR", () => {
    const out = renderTextDeltas(["oops **unclosed"], KIT);
    expect(out).toBe("oops \x1b[1munclosed\x1b[22m");
    // balanced: the closing SGR is always emitted (per-segment wraps)
    const opens = (out.match(/\x1b\[1m/g) ?? []).length;
    const closes = (out.match(/\x1b\[22m/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe("plain mode (no color): structure consumed, zero ANSI", () => {
  it("bold/italic/code/heading/fence shapes degrade to plain text (markers consumed)", () => {
    const out = renderTextDeltas(["## H\n**b** *i* `c`\n```\ncode\n```\n"], PLAIN, true);
    expect(out).toBe("## H\nb i c\n  code\n");
    expect(out).not.toContain("\x1b");
  });

  it("incremental push emits exactly what finish completes (no re-render)", () => {
    // push() must return partial output; concatenation === whole render
    const renderer = createMarkdownRenderer(KIT);
    const a = renderer.push("hello **");
    const b = renderer.push("world**!");
    const c = renderer.finish();
    expect(a).toBe("hello ");
    expect(b + c).toBe(`\x1b[1mworld\x1b[22m!`);
    expect(a + b + c).toBe("hello " + `\x1b[1mworld\x1b[22m!`);
  });
});
