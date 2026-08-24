/**
 * Web tools (round-27: "browser features for our agent" — Kilo/Cline parity).
 *
 *   - web_fetch: fetch any public URL and return readable text (HTML stripped
 *     to text, scripts/styles removed, size-capped). The workhorse — lets the
 *     agent read docs (MDN, react.dev, vitejs.dev), GitHub raw files, RFCs,
 *     blog posts, and any public page. This is the agent's "open a URL in a
 *     browser and read it" capability.
 *   - web_search: search the web for a query and return ranked results
 *     (title, url, snippet). Backed by the MediaWiki full-text search API,
 *     which returns reliable JSON for technical/programming concepts without
 *     a key or fragile HTML scraping. Honest by design: the description tells
 *     the model this is a knowledge search, not a generic web crawler.
 *
 * Both tools are dependency-free (Node fetch + minimal HTML→text). They never
 * touch the project filesystem, so no path containment is needed.
 */
import type { ToolResult } from "./index.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 16 * 1024;
const MAX_SEARCH_RESULTS = 6;

/** Schemes the agent is allowed to fetch. http(s) only — no file://, no data:. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * web_fetch — read a URL as text. HTML is stripped to a readable approximation
 * (scripts/styles/noscript removed, tags collapsed, whitespace normalized);
 * non-HTML content-types are returned raw (truncated). Always returns a string
 * the model can read, with the final URL (after redirects) + content-type +
 * byte count for context.
 */
export async function webFetch(url: string): Promise<ToolResult> {
  const trimmed = (url ?? "").trim();
  if (trimmed === "") return { ok: false, output: "web_fetch needs a non-empty 'url'" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, output: `web_fetch: '${trimmed}' is not a valid URL` };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, output: `web_fetch refuses scheme '${parsed.protocol}' — http(s) only` };
  }

  let response: Response;
  try {
    response = await fetch(trimmed, {
      // A real browser UA: some CDNs/anti-bots 403 the default undici UA.
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      output: `web_fetch: request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const finalUrl = response.url;
  const contentType = response.headers.get("content-type") ?? "(unknown content-type)";
  if (!response.ok) {
    return { ok: false, output: `web_fetch: HTTP ${response.status} for ${trimmed}` };
  }

  const buffer = await response.arrayBuffer();
  const raw = Buffer.from(buffer);
  const text = raw.toString("utf8");

  const isHtml = /html/i.test(contentType);
  const body = isHtml ? htmlToText(text) : text;
  const capped = body.length > MAX_FETCH_BYTES ? `${body.slice(0, MAX_FETCH_BYTES)}\n…[truncated at ${MAX_FETCH_BYTES} bytes]` : body;

  const header = [
    `url: ${finalUrl}`,
    `type: ${contentType}`,
    `bytes: ${raw.length}${body.length !== raw.length ? ` (→ ${body.length} as text)` : ""}`,
  ].join("\n");

  return {
    ok: true,
    output: `${header}\n\n${capped}`,
  };
}

/**
 * Minimal HTML → readable-text conversion (no deps). Removes script/style/
 * noscript/template content entirely, strips remaining tags, unescapes the
 * common entities, and collapses whitespace. Good enough for the agent to read
 * docs and code listings; not a full rendering engine.
 */
function htmlToText(html: string): string {
  let s = html;
  // Drop entire script/style/noscript/template blocks (with their content).
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ");
  // Remove HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level closers → newline so text doesn't run together.
  s = s.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|td|th|br|pre|code)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // Unescape common entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, "…");
  // Collapse runs of whitespace, preserving newlines.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** web_search — search the web for a query; returns ranked results. */
export async function webSearch(query: string): Promise<ToolResult> {
  const q = (query ?? "").trim();
  if (q === "") return { ok: false, output: "web_search needs a non-empty 'query'" };

  const results = await mediaWikiSearch(q, MAX_SEARCH_RESULTS);
  if (results.length === 0) {
    return { ok: true, output: `no results for '${q}'` };
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  return {
    ok: true,
    output: `${results.length} result(s) for '${q}':\n\n${lines.join("\n\n")}`,
  };
}

/**
 * MediaWiki full-text search (en.wikipedia.org/api.php list=search). Returns
 * reliable JSON for technical/programming concepts without a key or fragile
 * HTML scraping. Snippets carry <span class="searchmatch"> markers — stripped.
 */
async function mediaWikiSearch(query: string, limit: number): Promise<SearchResult[]> {
  const endpoint =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*" +
    `&srlimit=${limit}&srprop=snippet&srsearch=${encodeURIComponent(query)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { "user-agent": "AcuteCodeAgent/1.0 (web_search tool)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const search = (body as { query?: { search?: Array<{ title?: string; snippet?: string }> } })
    ?.query?.search;
  if (!Array.isArray(search)) return [];
  const out: SearchResult[] = [];
  for (const entry of search) {
    if (typeof entry?.title !== "string") continue;
    const title = entry.title;
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    const snippet = stripTags(typeof entry.snippet === "string" ? entry.snippet : "");
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** Remove HTML tags from a snippet and decode the common entities. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
