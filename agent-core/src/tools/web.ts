/**
 * Web tools (round-27: "browser features for our agent" — Kilo/Cline parity;
 * round-44: web_search upgraded from encyclopedia-only to REAL web search).
 *
 *   - web_fetch (round-27, unchanged): fetch any public URL and return readable
 *     text (HTML stripped to text, scripts/styles removed, size-capped). The
 *     workhorse — lets the agent read docs (MDN, react.dev, vitejs.dev), GitHub
 *     raw files, RFCs, blog posts, and any public page. This is the agent's
 *     "open a URL in a browser and read it" capability.
 *   - web_search (round-44 rewrite): search the REAL web — docs, GitHub
 *     issues, changelogs, blog posts, anything indexed — via DuckDuckGo's HTML
 *     endpoints. No API key, no scraping infrastructure, no new dependencies.
 *     Honest fallback chain, each tier tried only when the previous one fails
 *     or returns nothing parseable:
 *       1. html.duckduckgo.com/html/ — full layout; title anchors carry class
 *          result__a, snippet anchors result__snippet.
 *       2. lite.duckduckgo.com/lite/ — table layout; title links carry class
 *          result-link, snippet cells result-snippet.
 *       3. The round-27 MediaWiki (en.wikipedia.org) encyclopedia search as a
 *          last resort — the output is then prepended with a note so the
 *          model knows it is seeing encyclopedia results, not the web.
 *     DDG hrefs are redirect wrappers (…/l/?uddg=<percent-encoded target>&…);
 *     both parsers unwrap the uddg param back to the real result URL.
 *     Sponsored results (result--ad wrappers, duckduckgo.com/y.js click-tracker
 *     hrefs) and duckduckgo.com self-links are skipped. parseDdgHtml and
 *     parseDdgLite are exported for unit tests.
 *
 * Both tools are dependency-free (Node fetch + minimal HTML parsing). They
 * never touch the project filesystem, so no path containment is needed.
 */
import type { ToolResult } from "./index.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 16 * 1024;
/** Round-44: bumped from 6 to 8 — a coding agent needs a real results page. */
const MAX_SEARCH_RESULTS = 8;

/** Schemes the agent is allowed to fetch. http(s) only — no file://, no data:. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * A real browser UA + accept header: some CDNs/anti-bots 403 the default
 * undici UA. Shared by web_fetch and the DuckDuckGo search requests (round-44).
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

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
      headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT },
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
  s = decodeEntities(s);
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

/**
 * ROUND-45 (audit P0-5): secret-scrub a search query BEFORE it leaves the
 * machine. web_search talks only to fixed endpoints (DDG/Wikipedia), so the
 * query string is the only model-controlled part — a prompt-injected agent
 * could otherwise exfiltrate secrets by "searching" for them. Two layers:
 * exact keyring values (passed by the caller), then key-SHAPED patterns
 * (OpenRouter/OpenAI/GitHub/AWS/Slack) so even an unknown secret is caught.
 */
const KEY_SHAPED_PATTERNS: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
];

export function scrubSearchQuery(query: string, knownSecrets: readonly string[] = []): string {
  let out = query;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of KEY_SHAPED_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/**
 * web_search (round-44) — search the REAL web for a query; returns ranked
 * results (title, url, snippet). Chain: DuckDuckGo HTML → DuckDuckGo lite →
 * MediaWiki encyclopedia fallback (honestly labeled when it comes to that).
 */
export async function webSearch(query: string): Promise<ToolResult> {
  const q = (query ?? "").trim();
  if (q === "") return { ok: false, output: "web_search needs a non-empty 'query'" };

  // Tier 1: the full DuckDuckGo HTML layout.
  let results = await ddgHtmlSearch(q, MAX_SEARCH_RESULTS);
  // Tier 2: the simpler table-based lite layout.
  if (results.length === 0) results = await ddgLiteSearch(q, MAX_SEARCH_RESULTS);
  // Tier 3: encyclopedia fallback — labeled so the model knows the difference.
  let encyclopediaOnly = false;
  if (results.length === 0) {
    results = await mediaWikiSearch(q, MAX_SEARCH_RESULTS);
    encyclopediaOnly = results.length > 0;
  }

  if (results.length === 0) {
    return { ok: true, output: `no results for '${q}'` };
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  const note = encyclopediaOnly
    ? "[note: general web search unavailable — showing encyclopedia results]\n\n"
    : "";
  return {
    ok: true,
    output: `${note}${results.length} result(s) for '${q}':\n\n${lines.join("\n\n")}`,
  };
}

/** GET a search results page as text (browser headers, redirect-follow). */
async function fetchSearchPage(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/** Tier 1: html.duckduckgo.com/html/ (full layout). Null-safe tier entry. */
async function ddgHtmlSearch(query: string, limit: number): Promise<SearchResult[]> {
  const html = await fetchSearchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (html === null) return [];
  return parseDdgHtml(html).slice(0, limit);
}

/** Tier 2: lite.duckduckgo.com/lite/ (table layout). Null-safe tier entry. */
async function ddgLiteSearch(query: string, limit: number): Promise<SearchResult[]> {
  const html = await fetchSearchPage(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
  if (html === null) return [];
  return parseDdgLite(html).slice(0, limit);
}

/** One <a …>…</a> occurrence: byte offsets in the source + raw attrs + inner HTML. */
interface AnchorHit {
  start: number;
  end: number;
  attrs: string;
  inner: string;
}

/** Collect every anchor tag in the document, position-aware (zero-dep). */
function collectAnchors(html: string): AnchorHit[] {
  const hits: AnchorHit[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    hits.push({ start: m.index, end: re.lastIndex, attrs: m[1] ?? "", inner: m[2] ?? "" });
  }
  return hits;
}

/** Extract a named attribute value from a raw attribute string (`a=1 b='2'`). */
function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (m === null) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** True when the tag's class list contains the exact class name. */
function hasClass(attrs: string, className: string): boolean {
  const cls = attrValue(attrs, "class");
  return cls !== null && cls.toLowerCase().split(/\s+/).includes(className);
}

/**
 * Resolve a DuckDuckGo result href to the real target URL.
 *
 * DDG hrefs are redirect wrappers — protocol-relative links like
 * `//duckduckgo.com/l/?uddg=<percent-encoded target>&rut=…` (the lite endpoint
 * uses the same /l/ shape on lite.duckduckgo.com). We read the uddg param (the
 * URL API percent-decodes it for us) and validate the target. Direct http(s)
 * hrefs pass through unchanged. Returns null for: empty/unparseable hrefs,
 * redirect links without a uddg param, non-http(s) targets, and duckduckgo.com
 * itself (anti-recursion: searching the web must never yield DDG pages).
 */
function resolveDdgUrl(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    // Protocol-relative hrefs (`//duckduckgo.com/l/?…`) resolve against https.
    parsed = new URL(trimmed, "https://duckduckgo.com");
  } catch {
    return null;
  }
  let candidate = parsed;
  if (parsed.pathname === "/l/" || parsed.pathname === "/l") {
    const target = parsed.searchParams.get("uddg");
    if (target === null || target === "") return null;
    try {
      candidate = new URL(target);
    } catch {
      // Protocol-relative targets (`//example.com/x`) need a base too.
      try {
        candidate = new URL(target, "https://duckduckgo.com");
      } catch {
        return null;
      }
    }
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return null;
  // Anti-recursion / self-search guard.
  if (/(^|\.)duckduckgo\.com$/i.test(candidate.hostname)) return null;
  return candidate.toString();
}

/**
 * Parse the html.duckduckgo.com/html/ results page (zero-dep). Title anchors
 * carry class result__a; snippet anchors carry result__snippet and sit inside
 * the same result block (between this title anchor and the next one).
 * Sponsored results are skipped twice over: the anchor or its enclosing block
 * (everything since the previous title anchor, with style/script/comment noise
 * removed so head CSS like `.result--ad{…}` cannot false-positive) is marked
 * result--ad, and/or the href routes through duckduckgo.com/y.js (DDG's ad
 * click-tracker). Exported for unit tests.
 */
export function parseDdgHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const anchors = collectAnchors(html);
  const titles = anchors.filter((a) => hasClass(a.attrs, "result__a"));
  for (let i = 0; i < titles.length; i++) {
    const anchor = titles[i];
    const href = attrValue(anchor.attrs, "href") ?? "";
    // Ad guard 1: the anchor itself or its enclosing block is result--ad.
    const blockStart = i > 0 ? titles[i - 1].end : 0;
    const enclosingBlock = html
      .slice(blockStart, anchor.start)
      .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    if (hasClass(anchor.attrs, "result--ad") || /result--ad/i.test(enclosingBlock)) continue;
    // Ad guard 2: DDG ad links route through duckduckgo.com/y.js.
    if (/duckduckgo\.com\/y\.js/i.test(href)) continue;
    const url = resolveDdgUrl(href);
    if (url === null) continue;
    // The snippet (if any) is the first result__snippet anchor before the
    // next result's title anchor.
    const nextTitleStart = i + 1 < titles.length ? titles[i + 1].start : html.length;
    const snippet = anchors.find(
      (a) => a.start >= anchor.end && a.start < nextTitleStart && hasClass(a.attrs, "result__snippet"),
    );
    const title = cleanText(anchor.inner);
    if (title === "") continue;
    out.push({ title, url, snippet: snippet === undefined ? "" : cleanText(snippet.inner) });
  }
  return out;
}

/**
 * Parse the lite.duckduckgo.com/lite/ results page (zero-dep). The lite layout
 * is a table: title rows contain an <a class="result-link" href="…/l/?uddg=…">
 * and the snippet follows in a <td class="result-snippet"> cell before the
 * next result-link row. Same uddg unwrap, ad (y.js), and duckduckgo.com
 * self-link skipping as the HTML endpoint. Exported for unit tests.
 */
export function parseDdgLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const anchors = collectAnchors(html);
  // Snippet cells are <td> elements, not anchors — collect them separately.
  const snippets: AnchorHit[] = [];
  const cellRe = /<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(html)) !== null) {
    if (hasClass(cm[1] ?? "", "result-snippet")) {
      snippets.push({ start: cm.index, end: cellRe.lastIndex, attrs: cm[1] ?? "", inner: cm[2] ?? "" });
    }
  }
  const titles = anchors.filter((a) => hasClass(a.attrs, "result-link"));
  for (let i = 0; i < titles.length; i++) {
    const anchor = titles[i];
    const href = attrValue(anchor.attrs, "href") ?? "";
    if (/duckduckgo\.com\/y\.js/i.test(href)) continue;
    const url = resolveDdgUrl(href);
    if (url === null) continue;
    const nextTitleStart = i + 1 < titles.length ? titles[i + 1].start : html.length;
    const snippet = snippets.find((c) => c.start >= anchor.end && c.start < nextTitleStart);
    const title = cleanText(anchor.inner);
    if (title === "") continue;
    out.push({ title, url, snippet: snippet === undefined ? "" : cleanText(snippet.inner) });
  }
  return out;
}

/**
 * Strip HTML tags, decode the common entities, and collapse whitespace — the
 * cleanup every extracted title/snippet goes through. &amp; is decoded LAST so
 * pre-escaped text like "&amp;lt;" round-trips to the literal "&lt;" instead
 * of double-decoding to "<".
 */
function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Decode the entities DDG and MediaWiki markup actually emit (no deps). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&hellip;/gi, "…")
    .replace(/&amp;/gi, "&");
}

/**
 * MediaWiki full-text search (en.wikipedia.org/api.php list=search) — the
 * round-27 backend, demoted in round-44 to the encyclopedia LAST RESORT of the
 * web_search chain. Returns reliable JSON for technical/programming concepts
 * without a key or fragile HTML scraping. Snippets carry
 * <span class="searchmatch"> markers — stripped.
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
  return decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
}
