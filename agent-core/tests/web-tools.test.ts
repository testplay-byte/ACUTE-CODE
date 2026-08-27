/**
 * Round-27 web-tools unit tests; round-44 adds DuckDuckGo parser + fallback
 * chain coverage for the real web search. Fetch is MOCKED — no live network
 * calls in tests (TESTING.md hard rule #1: the only live model is exercised
 * in L4/L5 batteries). Each test stubs global fetch with a controlled
 * Response and asserts the tool's output shape + error handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDdgHtml, parseDdgLite, webFetch, webSearch } from "../src/tools/web";

/** Build a minimal Response-shaped object the web tools can consume. */
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  url?: string;
}): Response {
  const body = opts.body ?? "";
  const buffer = new TextEncoder().encode(body);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    url: opts.url ?? "https://example.com/page",
    headers: new Headers(opts.headers ?? { "content-type": "text/html; charset=utf-8" }),
    arrayBuffer: async () => buffer.buffer,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** First fetch argument as a string, whichever shape the caller used. */
function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return String(input);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // vitest resets mocks between tests automatically; we restore in afterEach.
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("web_fetch (round-27)", () => {
  it("rejects an empty url", async () => {
    const result = await webFetch("");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty 'url'");
  });

  it("refuses non-http schemes (file:// and data:)", async () => {
    const fileRes = await webFetch("file:///etc/passwd");
    expect(fileRes.ok).toBe(false);
    expect(fileRes.output).toContain("refuses scheme 'file:'");

    const dataRes = await webFetch("data:text/plain,hello");
    expect(dataRes.ok).toBe(false);
    expect(dataRes.output).toContain("refuses scheme 'data:'");
  });

  it("rejects a malformed url", async () => {
    const result = await webFetch("not a url at all");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a valid URL");
  });

  it("strips HTML to readable text and returns url/type/bytes header", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body:
          "<html><head><title>Ignored</title><style>body{color:red}</style></head>" +
          "<body><h1>Hello World</h1><p>This is a <strong>test</strong> page.</p>" +
          "<script>alert('removed');</script></body></html>",
        headers: { "content-type": "text/html; charset=utf-8" },
        url: "https://example.com/page",
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webFetch("https://example.com/page");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("url: https://example.com/page");
    expect(result.output).toContain("type: text/html");
    expect(result.output).toContain("bytes:");
    expect(result.output).toContain("Hello World");
    expect(result.output).toContain("This is a test page.");
    // script content must be stripped
    expect(result.output).not.toContain("alert('removed')");
    // style content must be stripped
    expect(result.output).not.toContain("color:red");
    // head/title stripped
    expect(result.output).not.toContain("Ignored");
  });

  it("returns raw text for non-HTML content types", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body: "plain text content without html",
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webFetch("https://example.com/readme.txt");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("type: text/plain");
    expect(result.output).toContain("plain text content without html");
  });

  it("caps body at 16KB with a truncation marker", async () => {
    const big = "A".repeat(20_000);
    globalThis.fetch = vi.fn(async () =>
      mockResponse({ body: big, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webFetch("https://example.com/big.txt");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("truncated at 16384 bytes");
    // the kept portion length (16384) + header should be present
    expect(result.output.length).toBeLessThan(big.length + 200);
  });

  it("returns a clean HTTP error when the server returns non-ok", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({ ok: false, status: 404, body: "", url: "https://example.com/missing" }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webFetch("https://example.com/missing");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("HTTP 404");
  });

  it("handles a network failure (fetch throws) gracefully", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ENOTFOUND example.com");
    }) as unknown as typeof globalThis.fetch;

    const result = await webFetch("https://example.com/down");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("request failed");
    expect(result.output).toContain("ENOTFOUND");
  });
});

// Since round-44 the chain tries DuckDuckGo first; these round-27 tests stub
// fetch with a single MediaWiki response, so every call (DDG html, DDG lite,
// MediaWiki) gets that same JSON — the DDG parsers find no anchors in it and
// the search falls through to the encyclopedia tier. They therefore now also
// pin the tier-3 behavior: same JSON in, same numbered list out (plus a note).
describe("web_search (round-27 — MediaWiki fixtures now exercise the tier-3 fallback)", () => {
  it("rejects an empty query", async () => {
    const result = await webSearch("");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty 'query'");
  });

  it("formats MediaWiki results as numbered title/url/snippet blocks", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body: JSON.stringify({
          query: {
            search: [
              {
                title: "TypeScript",
                snippet: 'A <span class="searchmatch">typed</span> superset of JavaScript',
              },
              {
                title: "JavaScript",
                snippet: 'A <span class="searchmatch">dynamic</span> language of the web',
              },
            ],
          },
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webSearch("typescript");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 result(s) for 'typescript'");
    expect(result.output).toContain("1. TypeScript");
    expect(result.output).toContain("https://en.wikipedia.org/wiki/TypeScript");
    // snippet HTML tags stripped
    expect(result.output).toContain("typed superset of JavaScript");
    expect(result.output).not.toContain("<span");
    expect(result.output).toContain("2. JavaScript");
  });

  it("returns a clean 'no results' message when MediaWiki finds nothing", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body: JSON.stringify({ query: { search: [] } }),
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webSearch("zzz-nothing-matches");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no results");
  });

  it("returns a clean 'no results' message when the API throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const result = await webSearch("anything");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no results");
  });

  it("returns a clean 'no results' message when the API returns non-200", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({ ok: false, status: 500, body: "" }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webSearch("anything");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no results");
  });

  it("skips entries with non-string titles (defensive parsing)", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body: JSON.stringify({
          query: {
            search: [
              { title: 123, snippet: "should be skipped" },
              { title: "Real Result", snippet: "kept" },
              { snippet: "no title field" },
            ],
          },
        }),
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webSearch("test");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 result(s)");
    expect(result.output).toContain("Real Result");
    expect(result.output).not.toContain("should be skipped");
  });
});

/**
 * html.duckduckgo.com/html/ fixture (hand-trimmed to the classes the parser
 * keys on). Covers: a normal uddg-redirect result, a head <style> that merely
 * MENTIONS .result--ad (must not poison the first result), an ad marked only
 * by its result--ad wrapper (clean uddg href — must still be skipped), an ad
 * routing through duckduckgo.com/y.js (skipped), an entity-heavy title, a
 * direct duckduckgo.com self-link (skipped), a uddg-wrapped duckduckgo.com
 * self-link (skipped), and a /l/ redirect with no uddg param (skipped).
 */
const DDG_HTML_FIXTURE = [
  "<html><head><style>.result--ad{display:none}</style></head><body><div class='results'>",
  "<div class='result results_links web-result'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2Fhandbook%2F2f%2Fnarrowing.html&amp;rut=8f3a'>TypeScript: Narrowing &amp; <b>type guards</b></a></h2>",
  "<a class='result__snippet' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2Fhandbook%2F2f%2Fnarrowing.html&amp;rut=8f3a'>How narrowing works with &#x27;typeof&#x27; &amp; the <code>in</code> operator.</a>",
  "</div>",
  "<div class='result result--ad'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fbuy.example.com%2Fts-course&amp;rut=ad01'>Learn TypeScript Fast</a></h2>",
  "<a class='result__snippet' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fbuy.example.com%2Fts-course&amp;rut=ad01'>Enroll in the #1 course today.</a>",
  "</div>",
  "<div class='result result--ad platinum'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='https://duckduckgo.com/y.js?ad_provider=yahoo;u1=https%3A%2F%2Fads.example.net%2Fts'>TS Bootcamp — Sponsored</a></h2>",
  "</div>",
  "<div class='result results_links web-result'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmicrosoft%2FTypeScript%2Fissues%2F53640&amp;rut=99c1'>microsoft/TypeScript#53640: &quot;asserts&quot; &amp; &lt;generics&gt; &#39;dont&#39; &nbsp;collapse</a></h2>",
  "<a class='result__snippet' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmicrosoft%2FTypeScript%2Fissues%2F53640&amp;rut=99c1'>Bug report: assertion signatures &hellip; regress in 5.4</a>",
  "</div>",
  "<div class='result'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='https://duckduckgo.com/?q=typescript+narrowing'>DuckDuckGo — typescript narrowing</a></h2>",
  "<a class='result__snippet' href='https://duckduckgo.com/?q=typescript+narrowing'>Search the web with DuckDuckGo.</a>",
  "</div>",
  "<div class='result'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fspread'>DuckDuckGo Spread</a></h2>",
  "</div>",
  "<div class='result'>",
  "<h2 class='result__title'><a rel='nofollow' class='result__a' href='//duckduckgo.com/l/?rut=missing'>Unresolvable redirect</a></h2>",
  "</div>",
  "</div></body></html>",
].join("\n");

/**
 * lite.duckduckgo.com/lite/ fixture: table rows with result-link anchors,
 * result-snippet cells, a result-url cell (ignored), a duckduckgo.com
 * self-link, and a y.js ad — only the two clean results survive.
 */
const DDG_LITE_FIXTURE = [
  "<html><body><table>",
  "<tr><td>1.&nbsp;<a rel='nofollow' href='https://lite.duckduckgo.com/l/?uddg=https%3A%2F%2Fvitejs.dev%2Fguide%2F&amp;rut=7c2f' class='result-link'>Vite Guide &amp; <b>Features</b></a></td></tr>",
  "<tr><td class='result-snippet'>Vite is a build tool that aims to provide a <b>faster</b> and leaner dev experience.</td></tr>",
  "<tr><td class='result-url'>vitejs.dev</td></tr>",
  "<tr><td>2.&nbsp;<a rel='nofollow' href='https://lite.duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fabout&amp;rut=8d3e' class='result-link'>About DuckDuckGo</a></td></tr>",
  "<tr><td class='result-snippet'>The search engine that doesn&#39;t track you.</td></tr>",
  "<tr><td>3.&nbsp;<a rel='nofollow' href='https://duckduckgo.com/y.js?ad_provider=xx;u1=https%3A%2F%2Fads.example.com%2Fvite' class='result-link'>SPONSORED — Vite hosting</a></td></tr>",
  "<tr><td class='result-snippet'>Deploy your Vite app today.</td></tr>",
  "<tr><td>4.&nbsp;<a rel='nofollow' href='https://lite.duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=9e4f' class='result-link'>Vitest — A blazing fast unit test framework</a></td></tr>",
  "<tr><td class='result-snippet'>Powered by Vite&nbsp;&amp; esbuild.</td></tr>",
  "</table></body></html>",
].join("\n");

describe("parseDdgHtml (round-44)", () => {
  it("extracts results, unwraps uddg redirects, decodes entities, skips ads + self-links + dead redirects", () => {
    expect(parseDdgHtml(DDG_HTML_FIXTURE)).toEqual([
      {
        title: "TypeScript: Narrowing & type guards",
        url: "https://www.typescriptlang.org/docs/handbook/2f/narrowing.html",
        snippet: "How narrowing works with 'typeof' & the in operator.",
      },
      {
        title: 'microsoft/TypeScript#53640: "asserts" & <generics> \'dont\' collapse',
        url: "https://github.com/microsoft/TypeScript/issues/53640",
        snippet: "Bug report: assertion signatures … regress in 5.4",
      },
    ]);
  });

  it("returns an empty array for pages without result__a anchors", () => {
    expect(parseDdgHtml("<html><body><p>no results here</p></body></html>")).toEqual([]);
    expect(parseDdgHtml("")).toEqual([]);
  });
});

describe("parseDdgLite (round-44)", () => {
  it("extracts table rows, unwraps uddg redirects, skips the self-link and the y.js ad", () => {
    expect(parseDdgLite(DDG_LITE_FIXTURE)).toEqual([
      {
        title: "Vite Guide & Features",
        url: "https://vitejs.dev/guide/",
        snippet: "Vite is a build tool that aims to provide a faster and leaner dev experience.",
      },
      {
        title: "Vitest — A blazing fast unit test framework",
        url: "https://vitest.dev/guide/",
        snippet: "Powered by Vite & esbuild.",
      },
    ]);
  });

  it("returns an empty array for pages without result-link anchors", () => {
    expect(parseDdgLite("<html><body><table><tr><td>nothing</td></tr></table></body></html>")).toEqual([]);
  });
});

describe("web_search fallback chain (round-44)", () => {
  it("returns real DDG results from the HTML endpoint (tier 1, no fallback calls)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(urlOf(input));
      return mockResponse({
        body: DDG_HTML_FIXTURE,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await webSearch("typescript narrowing");
    expect(calls).toEqual(["https://html.duckduckgo.com/html/?q=typescript%20narrowing"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 result(s) for 'typescript narrowing'");
    expect(result.output).toContain("1. TypeScript: Narrowing & type guards");
    expect(result.output).toContain("https://www.typescriptlang.org/docs/handbook/2f/narrowing.html");
    expect(result.output).toContain("How narrowing works with 'typeof' & the in operator.");
    expect(result.output).not.toContain("[note:");
  });

  it("falls back to the lite endpoint when the HTML endpoint returns 500 (tier 2)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      calls.push(url);
      if (url.startsWith("https://html.duckduckgo.com/")) {
        return mockResponse({ ok: false, status: 500, body: "" });
      }
      return mockResponse({
        body: DDG_LITE_FIXTURE,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await webSearch("vite guide");
    expect(calls).toEqual([
      "https://html.duckduckgo.com/html/?q=vite%20guide",
      "https://lite.duckduckgo.com/lite/?q=vite%20guide",
    ]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 result(s) for 'vite guide'");
    expect(result.output).toContain("1. Vite Guide & Features");
    expect(result.output).toContain("https://vitejs.dev/guide/");
    expect(result.output).not.toContain("[note:");
  });

  it("falls back to lite when the HTML endpoint request rejects (network error)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      calls.push(url);
      if (url.startsWith("https://html.duckduckgo.com/")) throw new Error("ECONNRESET");
      return mockResponse({
        body: DDG_LITE_FIXTURE,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await webSearch("vitest");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("https://lite.duckduckgo.com/lite/?q=vitest");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Vitest — A blazing fast unit test framework");
    expect(result.output).toContain("https://vitest.dev/guide/");
  });

  it("falls back to MediaWiki with an honest note when both DDG endpoints fail (tier 3)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      calls.push(url);
      if (url.includes("duckduckgo.com")) {
        return mockResponse({ ok: false, status: 503, body: "" });
      }
      return mockResponse({
        body: JSON.stringify({
          query: {
            search: [
              {
                title: "TypeScript",
                snippet: "A <span class='searchmatch'>typed</span> superset of JavaScript",
              },
            ],
          },
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await webSearch("typescript");
    expect(calls).toEqual([
      "https://html.duckduckgo.com/html/?q=typescript",
      "https://lite.duckduckgo.com/lite/?q=typescript",
      expect.stringContaining("https://en.wikipedia.org/w/api.php"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(
      "[note: general web search unavailable — showing encyclopedia results]",
    );
    expect(result.output).toContain("1. TypeScript");
    expect(result.output).toContain("https://en.wikipedia.org/wiki/TypeScript");
  });

  it("caps the result list at 8 (MAX_SEARCH_RESULTS)", async () => {
    const many = Array.from({ length: 10 }, (_, i) => {
      const target = `https%3A%2F%2Fexample.com%2Fpage%2F${i}`;
      return (
        `<h2 class='result__title'><a class='result__a' href='//duckduckgo.com/l/?uddg=${target}'>Result ${i}</a></h2>` +
        `<a class='result__snippet' href='//duckduckgo.com/l/?uddg=${target}'>Snippet ${i}</a>`
      );
    }).join("");
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        body: `<html><body>${many}</body></html>`,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await webSearch("many results");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("8 result(s) for 'many results'");
    expect(result.output).toContain("8. Result 7");
    expect(result.output).not.toContain("9. Result 8");
  });
});
