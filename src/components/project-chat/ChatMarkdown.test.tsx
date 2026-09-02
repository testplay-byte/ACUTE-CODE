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
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import {
  ChatMarkdown,
  CodeBlock,
  matchPath,
  parseMarkdownBlocks,
} from "./ChatMarkdown";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { renderWithProviders } from "../../test-utils";

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
      { kind: "code", code: "const a = 1;" },
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

describe("ChatMarkdown block rendering", () => {
  it("headings render as styled bold blocks — the raw # never shows", () => {
    renderMd("# Big\n## Medium\n### Small\n#### Tiny");
    // Inline runs render as spans INSIDE the heading div — query the block
    // element (the text node's parent) for the heading's own styling.
    const blockFor = (text: string): HTMLElement =>
      (screen.getByText(text) as HTMLElement).parentElement as HTMLElement;
    for (const text of ["Big", "Medium", "Small", "Tiny"]) {
      expect(blockFor(text).className).toContain("font-bold");
    }
    expect(document.body.textContent).not.toContain("##");
    expect(document.body.textContent).not.toContain("####");
    // h1/h2/h3 sizes per the R64-c spec (h4 is body-size bold).
    expect(blockFor("Big").style.fontSize).toBe("15px");
    expect(blockFor("Medium").style.fontSize).toBe("13.5px");
    expect(blockFor("Small").style.fontSize).toBe("12.5px");
    expect(blockFor("Tiny").style.fontSize).toBe("");
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
    // Line numbers 1 + 2 render (CodeBlock's gutter).
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
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
});
