/**
 * Round-27 web-tools unit tests. Fetch is MOCKED — no live network calls in
 * tests (TESTING.md hard rule #1: the only live model is exercised in L4/L5
 * batteries). Each test stubs global fetch with a controlled Response and
 * asserts the tool's output shape + error handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webFetch, webSearch } from "../src/tools/web";

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

describe("web_search (round-27)", () => {
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
