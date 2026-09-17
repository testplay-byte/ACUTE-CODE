// @vitest-environment happy-dom
/**
 * ROUND-64 (R64-c) tests — ChatMarkdown, the chat's markdown renderer (owner:
 * "Make sure it gets formatted like it should be, with the boldness made bold
 * and various other things"). The pre-R64 RichText pair handled only fences +
 * bold/inline-code — headings, lists, tables, italics, links, blockquotes and
 * rules printed as RAW TEXT.
 *
 * Covers: the pure line scanner (parseMarkdownBlocks), every block kind,
 * every inline mark, the ROUND-40 path-pill behavior (bare + inside inline
 * code), fenced code through the CodeBlock component, and the mid-stream
 * partial-markdown guarantee (an unterminated fence renders as a code block,
 * a dangling `**` renders as plain text).
 *
 * ROUND-98 (R98-D, ADR-0030): the mermaid leg — the scanner's `terminated`
 * flag, the lazy diagram mount for COMPLETE mermaid fences, the honest
 * source fallback on render failure, and the theme re-initialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  ChatMarkdown,
  CodeBlock,
  decodeEntities,
  isSafeUrl,
  matchPath,
  matchUrl,
  parseMarkdownBlocks,
} from "./ChatMarkdown";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
// R99-A: the link router's preference cache — the routing tests flip it and
// MUST restore "in-app" after (the module-level cache is file-wide).
import { setLinkOpeningMode } from "../../lib/open-link";
import { useThemeStore } from "../../lib/theme-store";
import { renderWithProviders } from "../../test-utils";

// R98-D: the mermaid mock. The factory-run counter is the LAZINESS observable
// — a factory evaluation means the dynamic import("mermaid") inside
// MermaidDiagram actually fired (nothing in this file imports mermaid at
// module scope). initialize/render are plain vi.fn()s; behaviors are armed
// per-test because the afterEach restoreAllMocks wipes them, and call counts
// are cleared in the mermaid describe's beforeEach.
//
// R101-F: the factory can be armed to THROW (factoryFailures > 0) — a
// throwing factory makes import("mermaid") REJECT (Vitest wraps the throw;
// the original error rides its `cause`), and the mock registry caches only
// SUCCESSFUL factory results, so the NEXT import re-runs the factory: the
// exact observable the bounded import retry (DEFECT 2) needs. The mermaid
// describe re-registers the mock per-test (vi.doMock) so every test starts
// with a COLD cache — otherwise a warm cache answers imports without ever
// evaluating the factory and the run counter stops being an observable.
const mockMermaid = vi.hoisted(() => {
  /** The ONE factory body — used by the hoisted vi.mock and the per-test
   * vi.doMock re-registration alike (a plain hoisted function, not a vi.fn,
   * so restoreAllMocks never wipes its counting). */
  function factory() {
    mockMermaid.factoryRuns += 1;
    if (mockMermaid.factoryFailures > 0) {
      mockMermaid.factoryFailures -= 1;
      // The production-shaped message: the exact string a WebView2 lazy-chunk
      // fetch failure produces ("Failed to fetch dynamically imported
      // module"), so the error-detail assertions pin real-world behavior.
      throw new Error(
        `Failed to fetch dynamically imported module: mermaid (factory run ${mockMermaid.factoryRuns})`,
      );
    }
    return {
      default: {
        initialize: mockMermaid.initialize,
        render: mockMermaid.render,
      },
    };
  }
  return {
    factoryRuns: 0,
    factoryFailures: 0,
    factory,
    initialize: vi.fn(),
    render: vi.fn(),
  };
});

vi.mock("mermaid", () => mockMermaid.factory());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT_ID = "proj_md_probe";

function renderMd(content: string) {
  return renderWithProviders(<ChatMarkdown content={content} projectId={PROJECT_ID} />);
}

describe("parseMarkdownBlocks (the pure line scanner)", () => {
  it("splits headings, paragraphs, lists, quotes, rules and fences", () => {
    const blocks = parseMarkdownBlocks(
      [
        "# Title",
        "",
        "Intro paragraph line one",
        "continued line two",
        "",
        "---",
        "",
        "- first bullet",
        "- second bullet",
        "  - nested bullet",
        "",
        "1. step one",
        "2. step two",
        "",
        "> quoted line",
        "> another quote line",
        "",
        "## Section",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "para", lines: ["Intro paragraph line one", "continued line two"] },
      { kind: "hr" },
      {
        kind: "bullets",
        items: [
          { level: 0, text: "first bullet" },
          { level: 0, text: "second bullet" },
          { level: 1, text: "nested bullet" },
        ],
      },
      {
        kind: "numbers",
        items: [
          { marker: "1", text: "step one" },
          { marker: "2", text: "step two" },
        ],
      },
      { kind: "quote", lines: ["quoted line", "another quote line"] },
      { kind: "heading", level: 2, text: "Section" },
    ]);
  });

  it("an UNTERMINATED code fence still parses as a code block (mid-stream)", () => {
    const blocks = parseMarkdownBlocks("before\n```ts\nconst a = 1;");
    expect(blocks).toEqual([
      { kind: "para", lines: ["before"] },
      // ROUND-95 (R95-F): the info string now rides the block as `lang`.
      // R98-D: `terminated` — false: the closing fence never arrived.
      { kind: "code", code: "const a = 1;", lang: "ts", terminated: false },
    ]);
  });

  it("GFM table detection requires the separator row (a lone pipe line is a paragraph)", () => {
    const table = parseMarkdownBlocks("| a | b |\n| --- | :-: |\n| 1 | 2 |");
    expect(table).toEqual([
      {
        kind: "table",
        header: ["a", "b"],
        aligns: ["left", "center"],
        rows: [["1", "2"]],
      },
    ]);
    const notTable = parseMarkdownBlocks("a | b");
    expect(notTable).toEqual([{ kind: "para", lines: ["a | b"] }]);
  });

  it("`***` and `___` are rules; a 2-char `--` is not", () => {
    expect(parseMarkdownBlocks("***")).toEqual([{ kind: "hr" }]);
    expect(parseMarkdownBlocks("___")).toEqual([{ kind: "hr" }]);
    expect(parseMarkdownBlocks("a -- b")).toEqual([{ kind: "para", lines: ["a -- b"] }]);
  });
});

describe("ROUND-95 (R95-F) parse fixes", () => {
  it("empty CONTENT renders an empty container (no ghost blocks, no crash)", () => {
    const { container } = renderMd("");
    // The ChatMarkdown root div survives (an empty <div class="min-w-0
    // break-words">) but renders ZERO children — no ghost paragraphs, no
    // empty code fence artifacts.
    const host = container.querySelector("div.break-words");
    expect(host).not.toBeNull();
    expect(host?.children.length).toBe(0);
  });

  it("fence info strings ride the code block as `lang` (backtick + tilde fences)", () => {
    // R98-D: `terminated` rides every CLOSED fence as true.
    expect(parseMarkdownBlocks("```python\nx=1\n```")).toEqual([
      { kind: "code", code: "x=1", lang: "python", terminated: true },
    ]);
    expect(parseMarkdownBlocks("~~~js\ny=2\n~~~")).toEqual([
      { kind: "code", code: "y=2", lang: "js", terminated: true },
    ]);
    expect(parseMarkdownBlocks("```\nz=3\n```")).toEqual([
      { kind: "code", code: "z=3", lang: "", terminated: true },
    ]);
  });

  it("each fence closes on its OWN marker (a ``` block does not close on ~~~)", () => {
    // R98-D: closed by its own ``` marker → terminated true.
    expect(parseMarkdownBlocks("```\nhas ~~~ inside\n```")).toEqual([
      { kind: "code", code: "has ~~~ inside", lang: "", terminated: true },
    ]);
  });

  it("bullets nest to arbitrary depth (indentation / 2 spaces per level)", () => {
    expect(parseMarkdownBlocks("- a\n  - b\n    - c\n      - d")).toEqual([
      {
        kind: "bullets",
        items: [
          { level: 0, text: "a" },
          { level: 1, text: "b" },
          { level: 2, text: "c" },
          { level: 3, text: "d" },
        ],
      },
    ]);
  });

  it("a heading's closing hash run is stripped (## Title ## → Title)", () => {
    expect(parseMarkdownBlocks("## Title ##")).toEqual([{ kind: "heading", level: 2, text: "Title" }]);
    // `C#` keeps its hash — the closer needs leading whitespace.
    expect(parseMarkdownBlocks("## About C#")).toEqual([{ kind: "heading", level: 2, text: "About C#" }]);
  });

  it("empty + whitespace-only markdown parses to zero blocks (no ghost elements)", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    expect(parseMarkdownBlocks("\n\n   \n\t\n")).toEqual([]);
  });
});

describe("ChatMarkdown block rendering", () => {
  it("headings render as styled bold blocks — the raw # never shows", () => {
    renderMd("# Big\n## Medium\n### Small\n#### Tiny");
    // Inline runs render as spans INSIDE the heading div — query the block
    // element (the text node's parent) for the heading's own styling.
    const blockFor = (text: string): HTMLElement =>
      (screen.getByText(text) as HTMLElement).parentElement as HTMLElement;
    // R100-D re-pin (§C4.4 + TOKENS §2): markdown headings snapped to the
    // ladder — 600 weight everywhere (font-semibold; 700 is wizard display
    // only), h1–h3 at 13px (the `section` tier) and h4–h6 at 12px — the old
    // 15/13.5/12.5px staircase was the measured "AI-generated" tell.
    for (const text of ["Big", "Medium", "Small", "Tiny"]) {
      expect(blockFor(text).className).toContain("font-semibold");
    }
    expect(document.body.textContent).not.toContain("##");
    expect(document.body.textContent).not.toContain("####");
    // h1–h3 = 13px (the cliff: body 13 → title 24, no in-between); h4 = 12px.
    expect(blockFor("Big").style.fontSize).toBe("13px");
    expect(blockFor("Medium").style.fontSize).toBe("13px");
    expect(blockFor("Small").style.fontSize).toBe("13px");
    expect(blockFor("Tiny").style.fontSize).toBe("12px");
  });

  it("bullets render with markers, one nesting level, and inline marks inside items", () => {
    renderMd("- **bold** item\n- plain item\n  - nested item");
    // The bold mark wraps its inner run in a span — assert the SEMANTIC
    // ancestor (strong), not the innermost text node's tag.
    expect(screen.getByText("bold").closest("strong")).toBeTruthy();
    // The marker column renders as its own span (• / ◦).
    const markers = document.body.textContent;
    expect(markers).toContain("•");
    expect(markers).toContain("◦");
    // No raw leading dashes survive.
    expect(document.querySelector("li")).toBeNull();
    expect(document.body.textContent).not.toMatch(/^- /m);
  });

  it("numbered lists keep their source markers in mono", () => {
    renderMd("1. first\n2. second");
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(document.body.textContent).toContain("1.");
    expect(document.body.textContent).toContain("2.");
  });

  it("blockquotes render with a left border and muted color", () => {
    renderMd("> quoted wisdom");
    expect(screen.getByText("quoted wisdom").closest(".border-l-2")).toBeTruthy();
    expect(document.body.textContent).not.toContain(">");
  });

  it("rules render as a divider, not raw dashes", () => {
    renderMd("above\n\n---\n\nbelow");
    const hr = document.querySelector(".border-t");
    expect(hr).toBeTruthy();
    expect(document.body.textContent).not.toContain("---");
  });

  it("GFM tables render a bordered table with monospace numeric cells", () => {
    renderMd("| File | Lines |\n| --- | ---: |\n| `src/a.ts` | 120 |\n| `src/b.ts` | docs |");
    const table = document.querySelector("table");
    expect(table).toBeTruthy();
    expect(table?.className).toContain("text-[11px]");
    expect(screen.getByText("File").closest("th")).toBeTruthy();
    expect(screen.getByText("Lines").closest("th")).toBeTruthy();
    // Numeric cell → font-mono; text cell → not (the td carries the class).
    expect(screen.getByText("120").closest("td")?.className).toContain("font-mono");
    expect(screen.getByText("docs").closest("td")?.className).not.toContain("font-mono");
    // Alignment from the separator colons (---: → right).
    expect((screen.getByText("120").closest("td") as HTMLElement).style.textAlign).toBe("right");
  });

  it("fenced code renders through the CodeBlock component (header + line numbers)", () => {
    renderMd("text before\n```ts\nconst a = 1;\nconst b = 2;\n```\ntext after");
    const copy = screen.getByRole("button", { name: "Copy code" });
    expect(copy).toBeTruthy();
    expect(screen.getByText("2 lines")).toBeTruthy();
    // Line numbers 1 + 2 render (CodeBlock's gutter). R97-J (m4) re-pin: the
    // highlighted path numbers its rows too — a Prism "token number" span
    // can also read as the bare text "1", so the gutters are asserted
    // structurally (each highlighted line's gutter is its previous sibling).
    const rows = Array.from(document.querySelectorAll("[data-code-highlighted]"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.previousElementSibling?.textContent)).toEqual(["1", "2"]);
    // The fence markers themselves never print.
    expect(document.body.textContent).not.toContain("```");
  });

  it("CodeBlock copy button writes the code to the clipboard", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    // happy-dom exposes navigator.clipboard as a getter-only property —
    // defineProperty (configurable) replaces it for the test.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    renderMd("```\nhello\n```");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(write).toHaveBeenCalledWith("hello");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

describe("ChatMarkdown inline rendering", () => {
  it("**bold**, *italic*, _italic_, __bold__, ~~strike~~ and `code`", () => {
    renderMd(
      "This is **bold** and *italic* and _also italic_ and __very bold__ and ~~struck~~ and `code`.",
    );
    expect(screen.getByText("bold").closest("strong")).toBeTruthy();
    expect(screen.getByText("very bold").closest("strong")).toBeTruthy();
    expect(screen.getByText("italic").closest("em")).toBeTruthy();
    expect(screen.getByText("also italic").closest("em")).toBeTruthy();
    expect(screen.getByText("struck").closest("del")).toBeTruthy();
    expect(screen.getByText("code").closest("code")).toBeTruthy();
    // The markers never print.
    expect(document.body.textContent).not.toContain("**");
    expect(document.body.textContent).not.toContain("~~");
  });

  it("snake_case_words never italicize (word-boundary guard on _italic_)", () => {
    renderMd("the snake_case_word stays plain");
    expect(document.querySelector("em")).toBeNull();
  });

  it("[text](url) links open in a new tab with rel=noreferrer", () => {
    renderMd("See [the docs](https://example.com/docs) for more.");
    const link = screen.getByRole("link", { name: "the docs" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(document.body.textContent).not.toContain("[the docs]");
  });

  it("nested marks: a path inside bold still becomes a PathPill", () => {
    renderMd("Edit **src/app.ts** now.");
    const pill = screen.getByRole("button", { name: "Open src/app.ts in sidebar" });
    expect(pill).toBeTruthy();
    expect(pill.closest("strong")).toBeTruthy();
  });

  it("ROUND-40 path pills: bare path tokens AND paths inside inline code open the file", () => {
    renderMd("See src/app.ts and `src/lib/api.ts` for details.");
    const bare = screen.getByRole("button", { name: "Open src/app.ts in sidebar" });
    const coded = screen.getByRole("button", { name: "Open src/lib/api.ts in sidebar" });
    expect(bare).toBeTruthy();
    expect(coded).toBeTruthy();

    // Clicking opens the file tab in the right sidebar (byProject is keyed
    // by project id — the tab row itself carries type + filePath + title).
    fireEvent.click(bare);
    const slices = Object.values(useRightSidebarStore.getState().byProject);
    expect(slices).toHaveLength(1);
    const tab = slices[0].tabs.find((t) => t.type === "file");
    expect(tab).toMatchObject({ type: "file", filePath: "src/app.ts" });
  });

  it("URLs never become path pills and non-path tokens stay plain text", () => {
    renderMd("Visit https://example.com/page.ts and keep Done. i.e. plain.");
    expect(screen.queryByRole("button", { name: /Open .* in sidebar/ })).toBeNull();
    // The URL lives inside a longer plain-text run — substring match it.
    expect(screen.getByText("https://example.com/page.ts", { exact: false })).toBeTruthy();
  });

  it("code spans beat other marks: `a *b* c` renders verbatim inside code", () => {
    renderMd("run `cmd *args* --flag` now");
    const code = screen.getByText("cmd *args* --flag");
    expect(code.tagName).toBe("CODE");
    expect(document.querySelector("em")).toBeNull();
  });
});

describe("matchPath (ROUND-40 contract, moved verbatim)", () => {
  it("matches file-like paths, rejects URLs/versions/sentences", () => {
    expect(matchPath("src/app.ts")).toBe("src/app.ts");
    expect(matchPath("./relative/file.py")).toBe("./relative/file.py");
    expect(matchPath("/abs/path.rs")).toBe("/abs/path.rs");
    expect(matchPath("`quoted.ts`")).toBe("quoted.ts");
    expect(matchPath("path/to/file.ts,")).toBe("path/to/file.ts");
    // ROUND-95 (R95-F): a QUOTED path followed by punctuation — the most
    // common shape in assistant prose — pills too (the quote used to strand).
    expect(matchPath('"src/app.ts",')).toBe("src/app.ts");
    expect(matchPath("`src/lib/api.ts`.")).toBe("src/lib/api.ts");
    expect(matchPath("https://example.com/x.ts")).toBeNull();
    expect(matchPath("Done.")).toBeNull();
    expect(matchPath("1.2.3")).toBeNull();
    expect(matchPath("hello")).toBeNull();
  });
});

describe("mid-stream partial markdown", () => {
  it("a dangling bold marker renders as plain text (never swallows the rest)", () => {
    renderMd("Answer so far: **bold part and still stream");
    expect(screen.getByText("Answer so far:", { exact: false })).toBeTruthy();
    expect(document.body.textContent).toContain("**bold part and still stream");
  });

  it("an open fence renders its partial content as a CodeBlock", () => {
    renderMd("Working on it:\n```\npartial code");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByText("partial code")).toBeTruthy();
  });
});

describe("CodeBlock direct render (moved from AgentChatPanel)", () => {
  it("renders one row per line with line numbers", () => {
    renderWithProviders(<CodeBlock code={"a\nb"} />);
    expect(screen.getByText("2 lines")).toBeTruthy();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
  });

  it("R95-F: a `lang` prop renders the language badge in the header", () => {
    renderWithProviders(<CodeBlock code={"x"} lang="rust" />);
    expect(document.querySelector("[data-code-lang]")?.textContent).toBe("rust");
    expect(screen.getByText("1 line")).toBeTruthy();
  });

  it("R95-F: no `lang` (or empty) renders NO badge", () => {
    renderWithProviders(<CodeBlock code={"x"} />);
    expect(document.querySelector("[data-code-lang]")).toBeNull();
  });
});

describe("ROUND-95 (R95-F) inline robustness", () => {
  it("***bold italic*** renders strong>em with no stray asterisks", () => {
    renderMd("This is ***very important*** text.");
    const el = screen.getByText("very important");
    expect(el.closest("em")).toBeTruthy();
    expect(el.closest("strong")).toBeTruthy();
    expect(document.body.textContent).not.toContain("***");
  });

  it("spaced emphasis delimiters are NOT emphasis (5 * 3 * 2 stays plain)", () => {
    renderMd("Compute 5 * 3 * 2 and ** spaced ** too.");
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("strong")).toBeNull();
    expect(document.body.textContent).toContain("5 * 3 * 2");
  });

  it("intraword __double underscores__ never bold (snake__case__names stay plain)", () => {
    renderMd("Keep some__thing__readable while __real bold__ works.");
    expect(screen.getByText("real bold").closest("strong")).toBeTruthy();
    expect(document.querySelectorAll("strong")).toHaveLength(1);
  });

  it("link destinations keep balanced parens (Wikipedia-style URLs)", () => {
    renderMd("See [Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar)) for context.");
    const link = screen.getByRole("link", { name: "Foo (bar)" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("the angle form [text](<url>) parses (URLs with spaces)", () => {
    renderMd("See [docs](<https://example.com/a b>) now.");
    const link = screen.getByRole("link", { name: "docs" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/a b");
  });

  it("javascript:/data: link destinations never become anchors", () => {
    renderMd("Try [click me](javascript:alert(1)) and [x](data:text/html,hi) now.");
    expect(screen.queryByRole("link")).toBeNull();
    // The raw markdown stays visible as plain text — honest, not half-eaten.
    expect(document.body.textContent).toContain("javascript:alert(1)");
  });

  it("bare URLs autolink, with sentence punctuation peeled and paren groups kept", () => {
    renderMd("Read https://en.wikipedia.org/wiki/Foo_(bar) and visit https://example.com/x.");
    const wiki = screen.getByRole("link", { name: "https://en.wikipedia.org/wiki/Foo_(bar)" }) as HTMLAnchorElement;
    expect(wiki.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    const plain = screen.getByRole("link", { name: "https://example.com/x" }) as HTMLAnchorElement;
    expect(plain.getAttribute("href")).toBe("https://example.com/x");
    // The peeled sentence period SURVIVES — outside the anchor, after it
    // (the pre-R95 autolink DROPPED it: every URL at a sentence's end lost
    // its period — the owner's "minor issues" class).
    expect(plain.textContent).toBe("https://example.com/x");
    expect(document.body.textContent).toMatch(/visit https:\/\/example\.com\/x\.$/);
  });

  it("the characters peeled off a token stay VISIBLE around pills and links", () => {
    renderMd('Opened "src/app.ts", then read (https://example.com/docs)**.');
    // The pill's surrounding quote + comma render as plain text.
    const pill = screen.getByRole("button", { name: /Open src\/app\.ts in sidebar/ }) as HTMLElement;
    expect(pill.textContent).toContain("src/app.ts");
    expect(document.body.textContent).toContain('"src/app.ts",');
    // The wrapping paren + the trailing dangling-asterisk run + period too.
    const link = screen.getByRole("link", { name: "https://example.com/docs" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.textContent).toBe("https://example.com/docs");
    expect(document.body.textContent).toContain("(https://example.com/docs)**.");
  });

  it("a dangling asterisk run peels off a bare URL (GFM autolink trailing set)", () => {
    renderMd("See https://example.com/flag** for the footnote.");
    const link = screen.getByRole("link", { name: "https://example.com/flag" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/flag");
    // The stray `**` renders as text after the link, never gloms onto it.
    expect(document.body.textContent).toContain("https://example.com/flag** for");
  });

  it("long unbreakable inline tokens carry break-all (no column overflow)", () => {
    renderMd(
      "Run `" +
        "aS3cr3tTok3nWithNoSpacesAtAll".repeat(8) +
        "` and see https://example.com/" +
        "very/long/path/segment/that/never/wraps/".repeat(4) +
        " end.",
    );
    const code = document.querySelector("code") as HTMLElement;
    expect(code.className).toContain("break-all");
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.className).toContain("break-all");
    // The paragraph column itself never overflows (break-words container).
    const para = code.closest("div[class*=break-words]") as HTMLElement | null;
    expect(para).not.toBeNull();
  });

  it("HTML entities decode in plain text but stay verbatim in code spans", () => {
    renderMd("Fish &amp; chips &lt;b&gt; &#65;&#x42; `&amp;` and &unknown; stay");
    expect(document.body.textContent).toContain("Fish & chips");
    expect(document.body.textContent).toContain("<b>");
    expect(document.body.textContent).toContain("AB");
    expect(screen.getByText("&amp;").tagName).toBe("CODE");
    // An unknown entity is never corrupted into a bare `&`.
    expect(document.body.textContent).toContain("&unknown;");
  });
});

describe("ROUND-95 (R95-F) block robustness", () => {
  it("fenced code shows the language badge from the info string — and R97-F highlights it", () => {
    renderMd("```tsx\nconst x = 1;\n```");
    expect(document.querySelector("[data-code-lang]")?.textContent).toBe("tsx");
    // R97-F: a known language renders Prism's token spans (the colors); the
    // code text still reads as textContent (split across token runs).
    const highlighted = document.querySelector("[data-code-highlighted]");
    expect(highlighted).toBeTruthy();
    expect(highlighted?.textContent).toBe("const x = 1;");
    expect(highlighted?.innerHTML).toContain("token keyword");
    // The marker + info string never print as code content.
    expect(document.body.textContent).not.toContain("```tsx");
  });

  it("a fence with no info string renders no badge (and stays plain — no highlight)", () => {
    renderMd("```\nconst x = 1;\n```");
    expect(document.querySelector("[data-code-lang]")).toBeNull();
    // No language → the plain-lines fallback, never a highlighted <code>.
    expect(document.querySelector("[data-code-highlighted]")).toBeNull();
    expect(screen.getByText("const x = 1;")).toBeTruthy();
  });

  it("R97-J (m4): a highlighted MULTI-LINE block keeps the line-number gutter — the same rows as the plain path", () => {
    renderMd("```ts\nconst a = 1;\n/* a comment\n   spanning lines */\nconst b = 2;\n```");
    // One highlighted span per line — the gutter is back on known-language
    // blocks (R97-F had silently dropped it for them).
    const rows = Array.from(document.querySelectorAll("[data-code-highlighted]"));
    expect(rows).toHaveLength(4);
    // The union of the per-line spans reads the exact code (the multi-line
    // comment re-opens its token spans on each continuation line).
    expect(rows.map((r) => r.textContent).join("\n")).toBe(
      "const a = 1;\n/* a comment\n   spanning lines */\nconst b = 2;",
    );
    // The comment's continuation lines carry the re-opened token class.
    expect(rows[1].innerHTML).toContain("token comment");
    expect(rows[2].innerHTML).toContain("token comment");
  });

  it("table rows with MORE cells than the header keep the extras (no dropped data)", () => {
    renderMd("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |");
    const table = document.querySelector("table");
    expect(table).toBeTruthy();
    expect(screen.getByText("3").closest("td")).toBeTruthy();
    expect(table?.querySelectorAll("thead th")).toHaveLength(3);
  });

  it("a very wide table scrolls INSIDE its block (overflow-x-auto + min-w-0 wrapper)", () => {
    renderMd("| one | two | three |\n| --- | --- | --- |\n| " + "x".repeat(400) + " | b | c |");
    const wrapper = document.querySelector("table")?.parentElement as HTMLElement;
    expect(wrapper.className).toContain("overflow-x-auto");
    expect(wrapper.className).toContain("min-w-0");
  });

  it("deeply nested bullets indent progressively (level 2 deeper than level 1)", () => {
    renderMd("- top\n  - mid\n    - deep");
    const rows = Array.from(document.querySelectorAll<HTMLElement>("div")).filter(
      (d) => d.style.paddingLeft !== "",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].style.paddingLeft).toBe("16px");
    expect(rows[1].style.paddingLeft).toBe("32px");
  });
});

describe("ROUND-95 (R95-F) mid-stream tolerance (the live tail)", () => {
  it("a half-arrived [link]( renders as plain text, never a broken anchor", () => {
    renderMd("See [the docs](https://example.com/docs for details");
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).toContain("[the docs](https://example.com/docs");
  });

  it("a half-arrived table separator degrades to a paragraph (no ghost table)", () => {
    // The bare "|" before any dashes arrives is NOT a separator row — the
    // table appears only once a real `|---|` cell lands.
    renderMd("| a | b |\n|");
    expect(document.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("| a | b |");
  });

  it("an unterminated fence at EOF keeps its language badge (streaming) — and highlights", () => {
    renderMd("```rust\nfn main() {");
    expect(document.querySelector("[data-code-lang]")?.textContent).toBe("rust");
    // R97-F: the partial rust code highlights too; the text survives as
    // textContent across the token runs.
    const highlighted = document.querySelector("[data-code-highlighted]");
    expect(highlighted).toBeTruthy();
    expect(highlighted?.textContent).toContain("fn main() {");
  });
});

describe("ROUND-95 (R95-F) helper contracts (matchUrl · isSafeUrl · decodeEntities)", () => {
  it("matchUrl: punctuation peeled, balanced parens kept, non-URLs rejected", () => {
    expect(matchUrl("https://example.com/x.")).toBe("https://example.com/x");
    expect(matchUrl("https://example.com/x,")).toBe("https://example.com/x");
    expect(matchUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(matchUrl("(https://example.com)")).toBe("https://example.com");
    // An unbalanced closing paren is sentence punctuation, not URL content.
    expect(matchUrl("https://example.com/f_(x)")).toBe("https://example.com/f_(x)");
    // The GFM autolink trailing set — a dangling emphasis run peels too.
    expect(matchUrl("https://example.com/flag**")).toBe("https://example.com/flag");
    expect(matchUrl("https://example.com/x_~")).toBe("https://example.com/x");
    expect(matchUrl("ftp://files.example.com/a")).toBe("ftp://files.example.com/a");
    expect(matchUrl("javascript:alert(1)")).toBeNull();
    expect(matchUrl("src/app.ts")).toBeNull();
    expect(matchUrl("hello")).toBeNull();
  });

  it("isSafeUrl: http/https/ftp/mailto + scheme-relative pass; script-y schemes refuse", () => {
    expect(isSafeUrl("https://x.com")).toBe(true);
    expect(isSafeUrl("http://x.com")).toBe(true);
    expect(isSafeUrl("mailto:a@b.c")).toBe(true);
    expect(isSafeUrl("#anchor")).toBe(true);
    expect(isSafeUrl("/relative/path")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,x")).toBe(false);
    expect(isSafeUrl("vbscript:x")).toBe(false);
  });

  it("decodeEntities: named + numeric decode once; unknown stays verbatim", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;"); // one pass, no double-decode
    expect(decodeEntities("&nbsp;")).toBe("\u00a0");
    expect(decodeEntities("&unknown; &#xZZ; &#9999999999;")).toBe("&unknown; &#xZZ; &#9999999999;");
  });
});

describe("ROUND-98 (R98-D) mermaid diagrams (ADR-0030)", () => {
  // Call counts are cleared per-test (implementations are armed per-test;
  // the file-level afterEach restoreAllMocks wipes the armed behaviors).
  // R101-F: the vi.doMock re-registration resets the mock to a COLD cache
  // (mockPath deletes the previous cached exports — see the mock's header
  // note) and factoryFailures re-arms to zero, so the factory-run counter is
  // a per-test observable for the retry legs below.
  beforeEach(() => {
    mockMermaid.initialize.mockClear();
    mockMermaid.render.mockClear();
    mockMermaid.factoryFailures = 0;
    vi.doMock("mermaid", () => mockMermaid.factory());
  });

  it("the scanner's `terminated` flag — true only when the CLOSING fence line arrived", () => {
    // R98-D: the flag that gates the mermaid branch. Closed backtick AND
    // tilde fences → true; the mid-stream dangling tail → false; a fence
    // whose closer is the OTHER marker never terminated.
    expect(parseMarkdownBlocks("```mermaid\nA\n```")).toEqual([
      { kind: "code", code: "A", lang: "mermaid", terminated: true },
    ]);
    expect(parseMarkdownBlocks("~~~mermaid\nB\n~~~")).toEqual([
      { kind: "code", code: "B", lang: "mermaid", terminated: true },
    ]);
    expect(parseMarkdownBlocks("```mermaid\nA")).toEqual([
      { kind: "code", code: "A", lang: "mermaid", terminated: false },
    ]);
    // A ~~~ fence closed by a ``` line: the ``` is CONTENT, never a closer.
    expect(parseMarkdownBlocks("~~~js\nconst a = 1;\n```")).toEqual([
      { kind: "code", code: "const a = 1;\n```", lang: "js", terminated: false },
    ]);
  });

  it("(a) a COMPLETE mermaid fence mounts the diagram card — verbatim code, strict config, injected SVG, lang badge", async () => {
    mockMermaid.render.mockResolvedValue({ svg: '<svg data-acute-mermaid="probe"><g /></svg>' });
    const runsBefore = mockMermaid.factoryRuns;
    renderMd("```mermaid\ngraph TD;\nA-->B\n```");
    // The fence-family card mounts immediately with the CodeBlock badge
    // spelling (data-code-lang="mermaid") and the loading announcement.
    expect(document.querySelector('[data-code-lang="mermaid"]')?.textContent).toBe("mermaid");
    expect(screen.getByRole("status", { name: "Rendering diagram" })).toBeTruthy();
    // The lazy import fired exactly once (the factory-run counter).
    await waitFor(() => expect(mockMermaid.render).toHaveBeenCalledTimes(1));
    expect(mockMermaid.factoryRuns).toBe(runsBefore + 1);
    // STRICT security, startOnLoad false, the theme follows the app store
    // (the store defaults to dark mode in this file).
    expect(mockMermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    // The code passed VERBATIM + the unique acute-mermaid render id.
    const [renderId, renderCode] = mockMermaid.render.mock.calls[0];
    expect(renderId).toMatch(/^acute-mermaid-\d+$/);
    expect(renderCode).toBe("graph TD;\nA-->B");
    // The SVG is injected into the card body; no Copy button (not a CodeBlock).
    await waitFor(() =>
      expect(document.querySelector('[data-acute-mermaid="probe"]')).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("(b) a render failure degrades to the amber note + the ordinary CodeBlock (never a crash)", async () => {
    mockMermaid.render.mockRejectedValue(new Error("unknown diagram type"));
    renderMd("```mermaid\nthis is not a diagram\n```");
    await waitFor(() =>
      expect(screen.getByText("Diagram could not be rendered — showing source")).toBeTruthy(),
    );
    // The note is the amber semantic warning, announced as a status.
    const note = screen.getByText("Diagram could not be rendered — showing source");
    expect(note.getAttribute("role")).toBe("status");
    expect(["#f59e0b", "rgb(245, 158, 11)"]).toContain((note as HTMLElement).style.color);
    // The source survives as an ordinary CodeBlock: Copy button + text.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByText("this is not a diagram")).toBeTruthy();
    // No diagram card: no loading status, no injected mermaid SVG (the only
    // svg on screen is the Copy button's lucide icon).
    expect(document.querySelector('[aria-label="Rendering diagram"]')).toBeNull();
    expect(document.querySelector("[data-acute-mermaid]")).toBeNull();
  });

  it("(c) a NON-mermaid fence stays an ordinary CodeBlock — no mermaid import delta", () => {
    const runsBefore = mockMermaid.factoryRuns;
    renderMd("```ts\nconst x = 1;\n```");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(document.querySelector("[data-code-lang]")?.textContent).toBe("ts");
    // No import delta: the lazy mermaid chunk never loads for ordinary fences.
    expect(mockMermaid.factoryRuns).toBe(runsBefore);
    expect(mockMermaid.render).not.toHaveBeenCalled();
  });

  it("(d) an UNCLOSED mermaid fence stays a CodeBlock (mid-stream) — no import, render never called", () => {
    const runsBefore = mockMermaid.factoryRuns;
    renderMd("```mermaid\ngraph TD;\nA-->B");
    // The ordinary CodeBlock: Copy button, its own lang badge, source visible.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(document.querySelector("[data-code-lang]")?.textContent).toBe("mermaid");
    expect(screen.getByText("A-->B")).toBeTruthy();
    // No diagram card mounts while the fence is still streaming in.
    expect(document.querySelector('[aria-label="Rendering diagram"]')).toBeNull();
    expect(mockMermaid.factoryRuns).toBe(runsBefore);
    expect(mockMermaid.render).not.toHaveBeenCalled();
  });

  it("a theme flip re-initializes mermaid with the light 'default' theme", async () => {
    mockMermaid.render.mockResolvedValue({ svg: '<svg data-acute-mermaid="theme-probe"></svg>' });
    renderMd("```mermaid\ngraph TD;\nA-->B\n```");
    await waitFor(() => expect(mockMermaid.initialize).toHaveBeenCalledTimes(1));
    expect(mockMermaid.initialize).toHaveBeenLastCalledWith({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    // Flip the app theme mode — the diagram re-initializes for light.
    act(() => {
      useThemeStore.setState({ mode: "light" });
    });
    await waitFor(() =>
      expect(mockMermaid.initialize).toHaveBeenLastCalledWith({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
      }),
    );
    // Restore the file's dark-mode default for any later assertions.
    act(() => {
      useThemeStore.setState({ mode: "dark" });
    });
  });

  it("(e) R101-F: a chunk-import failure retries ONCE — the factory runs twice, the diagram still renders", async () => {
    // DEFECT 2: a transient lazy-chunk fetch failure (asset-protocol hiccup,
    // AV interference in the packaged app) must not degrade the diagram —
    // it gets ONE bounded retry (the 400ms gap is real time; wait generous).
    mockMermaid.factoryFailures = 1; // the FIRST import("mermaid") rejects
    mockMermaid.render.mockResolvedValue({ svg: '<svg data-acute-mermaid="import-retry"></svg>' });
    const runsBefore = mockMermaid.factoryRuns;
    renderMd("```mermaid\ngraph TD;\nA-->B\n```");
    await waitFor(
      () => expect(document.querySelector('[data-acute-mermaid="import-retry"]')).toBeTruthy(),
      { timeout: 3000 },
    );
    // ONE retry — exactly TWO factory evaluations (the failed attempt + the
    // retry): the cold-cache re-registration makes the counter observable.
    expect(mockMermaid.factoryRuns).toBe(runsBefore + 2);
    expect(mockMermaid.render).toHaveBeenCalledTimes(1);
    // Recovered: no amber note anywhere.
    expect(screen.queryByText("Diagram could not be rendered — showing source")).toBeNull();
  });

  it("(f) R101-F: an import failure that PERSISTS surfaces its message — the note + the mono error detail", async () => {
    // DEFECT 2 + DEFECT 1: the SECOND rejection flows into the failure note
    // WITH its message — "Failed to fetch dynamically imported module" is
    // finally visible and diagnosable, not a silent amber catch. (Vitest
    // wraps the factory throw; the component walks `cause` to the reason.)
    mockMermaid.factoryFailures = 2; // BOTH attempts reject
    renderMd("```mermaid\ngraph TD;\nA-->B\n```");
    await waitFor(
      () => expect(screen.getByText("Diagram could not be rendered — showing source")).toBeTruthy(),
      { timeout: 3000 },
    );
    const detail = document.querySelector('[data-testid="mermaid-error-detail"]');
    expect(detail?.textContent).toContain("Failed to fetch dynamically imported module");
    // The source still survives as the ordinary CodeBlock fallback.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByText("graph TD;")).toBeTruthy();
    // render never ran — the chunk never loaded.
    expect(mockMermaid.render).not.toHaveBeenCalled();
  });

  it("(g) R101-F: a TRANSIENT render failure retries once with a FRESH id — the SVG lands", async () => {
    // DEFECT 3: mermaid.render can fail transiently (font/theme timing on a
    // freshly-mounted webview) even with valid syntax — mockRejectedValueOnce
    // is the observable shape for the single-throw case.
    mockMermaid.render
      .mockRejectedValueOnce(new Error("transient webview font timing"))
      .mockResolvedValue({ svg: '<svg data-acute-mermaid="render-retry"></svg>' });
    renderMd("```mermaid\ngraph TD;\nA-->B\n```");
    await waitFor(
      () => expect(document.querySelector('[data-acute-mermaid="render-retry"]')).toBeTruthy(),
      { timeout: 3000 },
    );
    // Exactly two render attempts, with DIFFERENT ids (the monotonic seq
    // bumps per attempt — an id mermaid may have registered is never reused).
    expect(mockMermaid.render).toHaveBeenCalledTimes(2);
    const ids = mockMermaid.render.mock.calls.map((call) => call[0]);
    expect(ids[0]).toMatch(/^acute-mermaid-\d+$/);
    expect(ids[1]).toMatch(/^acute-mermaid-\d+$/);
    expect(ids[0]).not.toBe(ids[1]);
    // Recovered: no amber note anywhere.
    expect(screen.queryByText("Diagram could not be rendered — showing source")).toBeNull();
  });

  it("(h) R101-F: a PERSISTENT render failure surfaces its message — the note + the mono error detail", async () => {
    // DEFECT 3 + DEFECT 1: both render attempts throw (a syntax error fails
    // twice identically — the honest price of covering the transient case)
    // → the amber note AND the reason, never a silent degradation.
    mockMermaid.render.mockRejectedValue(new Error("unknown diagram type"));
    renderMd("```mermaid\nthis is not a diagram\n```");
    await waitFor(() =>
      expect(screen.getByText("Diagram could not be rendered — showing source")).toBeTruthy(),
    );
    const detail = document.querySelector('[data-testid="mermaid-error-detail"]');
    expect(detail?.textContent).toContain("unknown diagram type");
    // Two attempts (the bounded retry), then the honest source fallback.
    expect(mockMermaid.render).toHaveBeenCalledTimes(2);
    expect(screen.getByText("this is not a diagram")).toBeTruthy();
  });
});

describe("ROUND-99 (R99-A) link routing — chat links open in the app's OWN browser", () => {
  // The router consults the right-sidebar store (openBrowser) and, for the
  // system leg, window.open — both need clean state per test, and the
  // preference cache must go back to the default so no later test in this
  // file inherits a flip.
  beforeEach(() => {
    useRightSidebarStore.setState({ byProject: {} });
    setLinkOpeningMode("in-app");
  });
  afterEach(() => {
    setLinkOpeningMode("in-app");
    vi.unstubAllGlobals();
  });

  /** The browser tabs currently sitting in the right-sidebar store. */
  function browserTabsInStore(): Array<{ browserUrl?: string | null }> {
    return Object.values(useRightSidebarStore.getState().byProject).flatMap((slice) =>
      slice.tabs.filter((t) => t.type === "browser"),
    );
  }

  it("a [text](url) click routes IN-APP — a browser tab lands in THIS project's sidebar; the href stays on the anchor", async () => {
    renderMd("See [the docs](https://example.com/docs) for more.");
    const link = screen.getByRole("link", { name: "the docs" }) as HTMLAnchorElement;
    // The a11y/copy-link contract: the REAL href + rel survive — only the
    // navigation is intercepted.
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noreferrer");

    fireEvent.click(link);
    await waitFor(() => {
      expect(browserTabsInStore()).toEqual([
        expect.objectContaining({ type: "browser", browserUrl: "https://example.com/docs" }),
      ]);
    });
    // The tab landed in the render's project slice (the component passes its
    // own projectId — no prop drilling through the chat tree).
    const key = Object.keys(useRightSidebarStore.getState().byProject)[0];
    expect(key).toContain(PROJECT_ID);
  });

  it("a bare-URL autolink click routes IN-APP the same way", async () => {
    renderMd("Visit https://example.com/autolink today.");
    const link = screen.getByRole("link", { name: "https://example.com/autolink" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/autolink");

    fireEvent.click(link);
    await waitFor(() => {
      expect(browserTabsInStore()).toEqual([
        expect.objectContaining({ type: "browser", browserUrl: "https://example.com/autolink" }),
      ]);
    });
  });

  it("a MIDDLE-CLICK (aux button 1) routes in-app too — the new-tab gesture maps to a new in-app browser tab", async () => {
    renderMd("See [the docs](https://example.com/middle) here.");
    const link = screen.getByRole("link", { name: "the docs" });
    // fireEvent has no auxClick alias in this testing-library version — the
    // raw MouseEvent dispatch is the same gesture (bubbles so React sees it).
    fireEvent(link, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await waitFor(() => {
      expect(browserTabsInStore()).toEqual([
        expect.objectContaining({ type: "browser", browserUrl: "https://example.com/middle" }),
      ]);
    });
    // An aux click with another button (e.g. right-click's button 2) never
    // routes — the native context menu owns that gesture.
    fireEvent(link, new MouseEvent("auxclick", { button: 2, bubbles: true }));
    expect(browserTabsInStore()).toHaveLength(1);
  });

  it("a mailto: link click is REFUSED by the router — no browser tab, no window.open (honest refusal, never guessed)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    renderMd("Write [support](mailto:someone@example.com) please.");

    fireEvent.click(screen.getByRole("link", { name: "support" }));
    // The anchor still renders with its real href (isSafeUrl's allowlist) —
    // but the router refuses the non-http(s) scheme: nothing opens.
    expect((screen.getByRole("link", { name: "support" }) as HTMLAnchorElement).getAttribute("href")).toBe(
      "mailto:someone@example.com",
    );
    expect(browserTabsInStore()).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("the 'system' preference sends the click to the OS browser instead (window.open in web mode)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    setLinkOpeningMode("system");
    renderMd("See [the docs](https://example.com/system-mode) here.");

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("https://example.com/system-mode", "_blank", "noreferrer");
    });
    expect(browserTabsInStore()).toHaveLength(0);
  });
});
