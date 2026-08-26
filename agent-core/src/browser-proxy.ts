/**
 * ROUND-43 (R43-10) — the EMBEDDED BROWSER BACKEND. The owner rejected the
 * R42 approach (window.open / native WebviewWindow pop-out): he wants a real
 * browser INSIDE the app's right sidebar. Sites like github.com send
 * X-Frame-Options / CSP frame-ancestors, so a naive <iframe src> can never
 * render them. This plugin is the server-side proxy that makes it work:
 *
 *   ┌──────────┐ GET /api/v1/browser/proxy?url=…&sessionId=…&bt=…   ┌─────────┐
 *   │ iframe   │ ─────────────────────────────────────────────────▶ │ sidecar │ ──▶ upstream
 *   │ (panel)  │ ◀── sanitized HTML, every sub-URL re-proxied ───── │  :5178  │ ◀── (fetch)
 *   └──────────┘                                                                └─────────┘
 *
 * ROUTES (all mounted under the existing bearer-auth scope; see the auth
 * note below for how header-less iframe navigations get in):
 *
 *   POST   /api/v1/browser/session        {sessionId?} → mint a proxy ticket
 *         → {sessionId, ticket, expiresAt, history, viewport}
 *         Rotates the ticket if the session already exists. DELETE with
 *         ?sessionId= drops the session + ticket.
 *   GET/POST /api/v1/browser/proxy        ?url=&sessionId=[&bt=]
 *         Server-side fetch of an http(s) URL (redirects followed, each hop
 *         re-guarded), then:
 *           text/html  → rewritten (base href, all sub-URLs re-proxied,
 *                        framing headers never forwarded, escape-hatch
 *                        script injected). POST = form passthrough (method,
 *                        content-type and body forwarded upstream).
 *           text/css   → url()/@import re-proxied.
 *           anything   → byte passthrough with the original content-type
 *                        (Range requests forwarded; 206 + content-range
 *                        pass back through).
 *         Failures return a SMALL self-contained HTML error page (never bare
 *         JSON — it renders inside the iframe) with the reason + requested
 *         URL. Statuses: 400 bad params · 403 scheme/private-net refused ·
 *         401 missing/expired ticket · 502 fetch/timeout/size failures ·
 *         upstream 4xx/5xx statuses are kept with our error page body.
 *   GET    /api/v1/browser/history        ?sessionId= → {entries, index,
 *         canBack, canForward} (entries: {url, title, ts}).
 *   POST   /api/v1/browser/navigate       {sessionId, url?, title?} records a
 *         navigation the panel observed (address bar / in-page link click —
 *         same URL twice = title update only) or {sessionId, direction:
 *         "back"|"forward"|"reload"} moves the pointer. → {sessionId, action,
 *         entry, index, canBack, canForward}.
 *   GET/PUT /api/v1/browser/viewport      ?sessionId= / body {sessionId,
 *         width?, height?, preset?, zoom?, rotate?} → {sessionId, viewport}.
 *         This is the display-size state BOTH the panel and the future
 *         agent `browser_control` tool read/write (validate 200..3840 ×
 *         200..4320, zoom 0.25..3).
 *
 * AUTH — why tickets exist: the sidecar's bearer wall lives in an app-level
 * preHandler hook that reads the Authorization HEADER, but an iframe's src
 * navigation (and every rewritten <img>/<link> inside it) cannot attach
 * headers. So the panel calls POST /browser/session (header-authed) to mint
 * a random 192-bit `bt` ticket bound to its tab's sessionId; proxy URLs then
 * carry `&bt=` and a scope-local onRequest hook promotes a VALID ticket to
 * the real bearer header (invalid/absent tickets never touch the wall —
 * they fall through to the normal 401). Tickets rotate on session re-mint,
 * expire after 12h (refreshed on use), and die with their session.
 *
 * FRONTEND-WAVE CONSUMPTION FLOW (the panel owns the iframe attributes —
 * sandbox="allow-scripts allow-forms allow-popups" WITHOUT allow-same-origin
 * is the recommended setting):
 *   1. POST /browser/session {sessionId: tabId}            → ticket
 *   2. POST /browser/navigate {sessionId, url}             → entry
 *   3. iframe.src = `${sidecarBaseUrl}/api/v1/browser/proxy?url=…&sessionId=…&bt=…`
 *   4. listen for iframe postMessages: {type:"acute:location", url} (final
 *      URL after redirects — record via POST /navigate when it differs from
 *      the current entry), {type:"acute:title", title} (re-POST /navigate
 *      with {url, title} to store it), {type:"acute:open", url} (a page
 *      window.open() — the PANEL decides: navigate in-panel or open
 *      externally; that is never the page's call).
 *
 * SECURITY POSTURE (v1, honest):
 *   - Scheme allowlist http/https only (file:, data:, javascript:, blob:,
 *     about: … refused as FETCH targets; javascript: hrefs are neutralized
 *     in rewrites; data:image|font|audio|video URIs already inside markup
 *     are left inline — no fetch happens for them).
 *   - Private-network SSRF guard: refuses to fetch localhost / 127.* / ::1 /
 *     169.254.* / 10.* / 192.168.* / 172.16-31.* targets (hostname check
 *     only — v1 does NOT resolve DNS, so a public hostname that A-records to
 *     a LAN IP would pass; noted, acceptable for v1). Redirect hops are
 *     re-guarded so an upstream cannot bounce us into the LAN mid-fetch.
 *     The owner tests HIS OWN app in the embedded browser, so the app's own
 *     vite dev server is allowlisted: PRIVATE_NET_ALLOWLIST below (editable
 *     constant).
 *   - NO cookie/authorization forwarding to upstreams — logins do NOT
 *     persist through the proxy in v1 (the Tauri native browser window
 *     remains the login-capable path). Our own bearer/ticket never leaks to
 *     an upstream.
 *   - Response header hygiene: framing blockers (x-frame-options, CSP,
 *     COOP/COEP, permissions-policy, HSTS) are simply never forwarded, and
 *     in-document <meta http-equiv="content-security-policy"> tags are
 *     stripped; no Access-Control-Allow-Origin is added.
 *   - Bounded work: 20s deadline (across the redirect chain), 25 MiB body
 *     cap, ≤10 redirect hops, sessionId regex-validated (alphanumeric plus
 *     . _ -, ≤64 chars) so it cannot inject into rewritten URLs.
 *
 * KNOWN LIMITATIONS (v1, deliberate — regex rewriter, zero new deps):
 *   - Rewriting is single-pass, tag-scoped regex. It handles quoted and
 *     unquoted attribute values, but URLs built BY JavaScript at runtime
 *     (fetch/XHR, SPA routers) resolve against the injected <base> and miss
 *     the proxy entirely — heavily scripted sites (github's React app
 *     included) render partially. The window.open escape hatch catches the
 *     main navigation case; a future wave can add a service-worker shim.
 *   - POST forms pass method+content-type+body through, but multipart file
 *     uploads are forwarded as an opaque buffer (untested) and flows
 *     dependent on hidden-input cookies/CORS will not work.
 *   - srcset candidates containing commas inside data: URLs are re-merged
 *     heuristically (split-on-comma is what the HTML spec itself does);
 *     pathological base64 payloads may still split wrong.
 *   - Decoding is UTF-8 only (response.text()); legacy charsets mojibake.
 *   - <textarea>/<pre> text that looks like tags could be rewritten —
 *     accepted miss; script bodies are placeholder-protected during the
 *     tag pass precisely to avoid the equivalent (and worse) problem there.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ─────────────────────────── constants ─────────────────────────────────────

const PROXY_PATH = "/api/v1/browser/proxy";

/** 20s covers the whole redirect chain (each hop gets the remaining time). */
const FETCH_DEADLINE_MS = 20_000;
/** Generous but bounded: whole-response cap for HTML/CSS/binary alike. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 10;
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;

/** Bounded per-tab state: ≤32 sessions (LRU), ≤50 history entries each. */
const MAX_SESSIONS = 32;
const MAX_HISTORY = 50;

/** sessionId charset/length (prevents injection into rewritten URLs). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Minted tickets are randomBytes(24) hex → 48 lowercase hex chars. */
const TICKET_RE = /^[a-f0-9]{48}$/;

const VIEWPORT_MIN_W = 200;
const VIEWPORT_MAX_W = 3840;
const VIEWPORT_MIN_H = 200;
const VIEWPORT_MAX_H = 4320;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

/** Display-size presets (R43-10 list). `custom` is what explicit dims store. */
export const VIEWPORT_PRESETS: Readonly<Record<string, { width: number; height: number }>> = {
  "mobile-sm": { width: 375, height: 667 },
  "mobile-md": { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1280, height: 800 },
  desktop: { width: 1440, height: 900 },
  "full-hd": { width: 1920, height: 1080 },
};

export interface BrowserViewport {
  width: number;
  height: number;
  /** Preset id from VIEWPORT_PRESETS or "custom". Advisory metadata. */
  preset: string;
  /** 0.25..3 (panel render zoom, not a device-pixel ratio). */
  zoom: number;
  rotate: boolean;
}

export const DEFAULT_VIEWPORT: BrowserViewport = {
  width: VIEWPORT_PRESETS.laptop.width,
  height: VIEWPORT_PRESETS.laptop.height,
  preset: "laptop",
  zoom: 1,
  rotate: false,
};

/**
 * Private-network exception list — the app's OWN vite dev server, because the
 * owner tests his own app inside the embedded browser. Editable constant:
 * entries are plain `host:port` (IPv6 without brackets).
 */
const PRIVATE_NET_ALLOWLIST: readonly string[] = [
  "127.0.0.1:5173",
  "localhost:5173",
  "::1:5173",
];
/** Module-level so tests can extend it (hermetic mock upstreams run local). */
const privateNetAllow = new Set<string>(PRIVATE_NET_ALLOWLIST);

/** Test-only: allow an extra `host:port` through the private-net guard. */
export function extendPrivateNetAllowlistForTest(hostPort: string): void {
  privateNetAllow.add(hostPort.toLowerCase());
}

/** Test-only: restore the shipped allowlist. */
export function resetPrivateNetAllowlistForTest(): void {
  privateNetAllow.clear();
  for (const entry of PRIVATE_NET_ALLOWLIST) privateNetAllow.add(entry);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// ───────────────────────────── types ───────────────────────────────────────

export interface HistoryEntry {
  url: string;
  title: string | null;
  ts: number;
}

interface BrowserSession {
  sessionId: string;
  ticket: string;
  ticketExpiresAt: number;
  history: HistoryEntry[];
  /** Current pointer into history; -1 = empty. */
  index: number;
  viewport: BrowserViewport;
}

/** Control-flow error carrying the HTTP status + short reason for the page. */
class ProxyFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RewriteCtx {
  /** Final upstream URL (after redirects) — the <base> href. */
  pageUrl: string;
  sessionId: string;
  ticket: string;
}

// ─────────────────────── private-network guard ─────────────────────────────

/** True when the host is a loopback/link-local/RFC1918 target we refuse. */
function isPrivateHost(hostname: string, port: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const hostPort = `${host}:${port}`;
  if (privateNetAllow.has(hostPort)) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "0.0.0.0") return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** Throws ProxyFailure for refused schemes / private-network targets. */
function guardTarget(target: URL): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ProxyFailure(
      403,
      "SCHEME_BLOCKED",
      `refused scheme '${target.protocol}' — the embedded browser proxies http(s) only`,
    );
  }
  if (isPrivateHost(target.hostname, target.port)) {
    throw new ProxyFailure(
      403,
      "PRIVATE_NETWORK_BLOCKED",
      `refused private-network target ${target.host} (sidecar SSRF guard; the app's own dev server is allowlisted)`,
    );
  }
}

// ────────────────────── session store (bounded LRU) ────────────────────────

function mintTicket(): string {
  return randomBytes(24).toString("hex");
}

class SessionStore {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly ticketIndex = new Map<string, string>();

  get(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** LRU touch: re-insert so eviction order reflects use. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  /** Creates or adopts a session, (re)minting its proxy ticket. */
  create(sessionId: string): BrowserSession {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.ticketIndex.delete(existing.ticket);
      existing.ticket = mintTicket();
      existing.ticketExpiresAt = Date.now() + TICKET_TTL_MS;
      this.ticketIndex.set(existing.ticket, sessionId);
      this.touch(sessionId);
      return existing;
    }
    const session: BrowserSession = {
      sessionId,
      ticket: mintTicket(),
      ticketExpiresAt: Date.now() + TICKET_TTL_MS,
      history: [],
      index: -1,
      viewport: { ...DEFAULT_VIEWPORT },
    };
    this.sessions.set(sessionId, session);
    this.ticketIndex.set(session.ticket, sessionId);
    this.evictIfNeeded();
    return session;
  }

  drop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    this.ticketIndex.delete(session.ticket);
    this.sessions.delete(sessionId);
    return true;
  }

  /** Resolves a `bt` ticket; expired tickets are forgotten. */
  byTicket(ticket: string): BrowserSession | undefined {
    if (!TICKET_RE.test(ticket)) return undefined;
    const sessionId = this.ticketIndex.get(ticket);
    if (sessionId === undefined) return undefined;
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.ticket !== ticket) {
      this.ticketIndex.delete(ticket);
      return undefined;
    }
    if (session.ticketExpiresAt <= Date.now()) {
      this.drop(sessionId);
      return undefined;
    }
    return session;
  }

  refreshTicket(session: BrowserSession): void {
    session.ticketExpiresAt = Date.now() + TICKET_TTL_MS;
  }

  private evictIfNeeded(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldestId = this.sessions.keys().next().value;
      if (oldestId === undefined) break;
      this.drop(oldestId);
    }
  }
}

// ───────────────────────── URL mapping / rewrites ──────────────────────────

function buildProxyUrl(absoluteUrl: string, ctx: RewriteCtx): string {
  const query = new URLSearchParams({
    url: absoluteUrl,
    sessionId: ctx.sessionId,
    bt: ctx.ticket,
  });
  return `${PROXY_PATH}?${query.toString()}`;
}

type UrlKind = "link" | "asset" | "media" | "frame" | "form" | "srcset";

/** data: URIs that are safe to keep inline (no proxy fetch happens). */
const INLINE_DATA_RE = /^data:(?:image|font|audio|video)\/|^data:application\/font/i;
/** Schemes that must never survive as clickable/fetchable targets. */
const NEUTRALIZED_SCHEME_RE =
  /^(?:javascript|vbscript|file|blob|about|chrome|chrome-extension|moz-extension|ws|wss|data):/i;

/**
 * Maps one raw attribute value to what the iframe should use. Relative URLs
 * are absolute-ized against the page URL, http(s) targets become proxy
 * links, dangerous schemes are neutralized to "#", and URLs already pointing
 * at our own proxy pass through untouched.
 */
function mapPageUrl(raw: string, ctx: RewriteCtx, kind: UrlKind): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return trimmed;
  if (/^data:/i.test(trimmed)) {
    return (kind === "media" || kind === "asset" || kind === "srcset") && INLINE_DATA_RE.test(trimmed)
      ? trimmed
      : "#";
  }
  if (/^(?:javascript|vbscript):/i.test(trimmed)) return "#";
  if (NEUTRALIZED_SCHEME_RE.test(trimmed)) return "#";

  let resolved: URL;
  try {
    resolved = new URL(trimmed, ctx.pageUrl);
  } catch {
    return trimmed; // unparseable — leave untouched rather than corrupt it
  }
  if (resolved.pathname === PROXY_PATH) return trimmed; // already proxied
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return "#";
  if (isPrivateHost(resolved.hostname, resolved.port)) return "#"; // never rewrite INTO a guard bypass
  return buildProxyUrl(resolved.toString(), ctx);
}

/** Tag-scoped attribute rewrite; honors double/single-quoted + unquoted. */
function mapAttrValues(tag: string, attr: string, map: (value: string) => string): string {
  const re = new RegExp(`(\\s${attr}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'>]+)`, "gi");
  return tag.replace(re, (_match: string, prefix: string, raw: string) => {
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : "";
    const inner = quote === "" ? raw : raw.slice(1, -1);
    return `${prefix}${quote}${map(inner)}${quote}`;
  });
}

/** Removes an attribute entirely (used for `integrity` — SRI breaks rewrites). */
function stripAttr(tag: string, attr: string): string {
  return tag.replace(new RegExp(`\\s+${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)`, "gi"), "");
}

/**
 * srcset rewrite: split on commas (what the HTML spec does), re-merge parts
 * that are obviously data:URL continuations, rewrite each candidate URL but
 * keep its descriptor. data: candidates stay inline.
 */
function mapSrcset(value: string, ctx: RewriteCtx): string {
  const parts = value.split(",");
  const candidates: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (candidates.length > 0 && !looksLikeCandidateStart(trimmed)) {
      candidates[candidates.length - 1] += `,${part}`;
      continue;
    }
    candidates.push(part);
  }
  return candidates
    .map((part) => {
      const trimmed = part.trim();
      const split = trimmed.search(/\s/);
      const url = split === -1 ? trimmed : trimmed.slice(0, split);
      const descriptor = split === -1 ? "" : trimmed.slice(split);
      if (/^data:/i.test(url)) return part;
      return `${mapPageUrl(url, ctx, "srcset")}${descriptor}`;
    })
    .join(", ");
}

/** A real srcset candidate starts with a scheme, a path, or a dotted file. */
function looksLikeCandidateStart(token: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(token) ||
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    /^[^\s/]+\.[^\s/]+(?=\s|$)/.test(token)
  );
}

/** CSS url(...) + @import "..." rewriting (stylesheet bodies + style attrs). */
function rewriteCssText(css: string, ctx: RewriteCtx): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m: string, q: string, u: string) => {
      return `url(${q}${mapPageUrl(u.trim(), ctx, "asset")}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m: string, q: string, u: string) => {
      return `@import ${q}${mapPageUrl(u.trim(), ctx, "asset")}${q}`;
    });
}

/** Which attributes of which tags carry URLs, and how they behave. */
const TAG_ATTR_RULES: Readonly<Record<string, ReadonlyArray<{ attr: string; kind: UrlKind }>>> = {
  a: [{ attr: "href", kind: "link" }],
  area: [{ attr: "href", kind: "link" }],
  link: [{ attr: "href", kind: "asset" }],
  script: [{ attr: "src", kind: "asset" }],
  img: [
    { attr: "src", kind: "media" },
    { attr: "srcset", kind: "srcset" },
  ],
  source: [
    { attr: "src", kind: "media" },
    { attr: "srcset", kind: "srcset" },
  ],
  iframe: [{ attr: "src", kind: "frame" }],
  form: [{ attr: "action", kind: "form" }],
  video: [
    { attr: "src", kind: "media" },
    { attr: "poster", kind: "media" },
  ],
  audio: [{ attr: "src", kind: "media" }],
  track: [{ attr: "src", kind: "media" }],
  embed: [{ attr: "src", kind: "media" }],
  object: [{ attr: "data", kind: "asset" }],
  input: [{ attr: "src", kind: "media" }], // <input type=image>
};

const TAG_NAME_RE = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/;

/** Rewrites the URL-bearing attributes of ONE tag string. */
function rewriteTag(tag: string, ctx: RewriteCtx): string {
  const nameMatch = TAG_NAME_RE.exec(tag);
  if (nameMatch === null) return tag;
  const name = nameMatch[1].toLowerCase();

  let out = tag;
  const rules = TAG_ATTR_RULES[name];
  if (rules !== undefined) {
    for (const rule of rules) {
      out = mapAttrValues(out, rule.attr, (v) =>
        rule.kind === "srcset" ? mapSrcset(v, ctx) : mapPageUrl(v, ctx, rule.kind),
      );
    }
  }

  if (name === "link" || name === "script") {
    // SRI hashes never match rewritten CSS/JS bodies — drop them or the
    // browser blocks the (otherwise fine) subresource.
    out = stripAttr(out, "integrity");
  }

  if (name === "meta" && /http-equiv\s*=\s*["']?\s*refresh/i.test(out)) {
    out = mapAttrValues(out, "content", (v) =>
      v.replace(/^(\s*[\d.]+\s*[;,]\s*url\s*=\s*)(.*)$/is, (_m: string, pre: string, u: string) => {
        const cleaned = u.trim().replace(/^["']|["']$/g, "");
        return `${pre}"${mapPageUrl(cleaned, ctx, "link")}"`;
      }),
    );
  }

  if (name === "form" && !/\saction\s*=/i.test(out)) {
    // No action → native submit would target the document URL and DROP the
    // proxy query. Point it at the current page's proxy URL explicitly.
    const action = buildProxyUrl(ctx.pageUrl, ctx).replace(/"/g, "%22");
    out = out.replace(/\s*\/?>$/, ` action="${action}">`);
  }

  return mapAttrValues(out, "style", (v) => rewriteCssText(v, ctx));
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Tiny page-side agent injected before </body>. Runs inside the sandboxed
 * iframe (opaque origin) so it postMessages with "*" — the PANEL filters by
 * message type. Surfaces: final URL, real document title (also on later
 * changes), and window.open attempts routed to the panel's decision.
 */
function buildEscapeScript(finalUrl: string): string {
  const urlLiteral = JSON.stringify(finalUrl).replace(/</g, "\\u003c");
  return (
    `<script>(function(){if(window.__ACUTE_BROWSER__)return;window.__ACUTE_BROWSER__=1;` +
    `function send(m){try{parent.postMessage(m,"*")}catch(e){}}` +
    `window.open=function(u){send({type:"acute:open",url:u==null?"":String(u)});return null};` +
    `var last=null;function sendTitle(){var t=document.title||"";if(t!==last){last=t;send({type:"acute:title",title:t})}}` +
    `send({type:"acute:location",url:${urlLiteral}});` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",sendTitle)}else{sendTitle()}` +
    `window.addEventListener("load",sendTitle);` +
    `try{var tEl=document.querySelector("title");if(tEl){new MutationObserver(sendTitle).observe(tEl,{childList:true,characterData:true,subtree:true})}}catch(e){}` +
    `})();</script>`
  );
}

/** HTML sanitization + rewriting pipeline (order matters — see docblock). */
export function rewriteHtml(html: string, ctx: RewriteCtx): string {
  // 1. Protect script bodies from the tag pass (JS strings that look like
  //    tags must not be rewritten; their src attributes still are).
  const scriptBodies: string[] = [];
  let out = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (_m: string, attrs: string, code: string) => {
      scriptBodies.push(code);
      return `<script${attrs} data-acute-ph="${scriptBodies.length - 1}"></script>`;
    },
  );

  // 2. Drop the page's own <base> tags — ours is authoritative.
  out = out.replace(/<base\b[^>]*\/?>/gi, "");
  // 3. Drop in-document CSP / XFO meta tags (framing blockers from inside).
  out = out.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:content-security-policy(?:-report-only)?|x-frame-options)[^>]*\/?>/gi,
    "",
  );

  // 4. Inject <base href> so runtime-relative resolution lands upstream.
  const baseTag = `<base href="${escapeHtmlAttr(ctx.pageUrl)}">`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + baseTag);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + baseTag);
  else out = baseTag + out;

  // 5. Tag-scoped attribute rewriting (single pass over tags).
  out = out.replace(/<[a-zA-Z][^>]*>/g, (tag) => rewriteTag(tag, ctx));

  // 6. <style> block bodies (their TAGS were already handled in 5).
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_m: string, open: string, css: string, close: string) =>
      `${open}${rewriteCssText(css, ctx)}${close}`,
  );

  // 7. Escape hatch before </body> (while script placeholders are still out).
  const escapeScript = buildEscapeScript(ctx.pageUrl);
  if (/<\/body\s*>/i.test(out)) out = out.replace(/<\/body\s*>/i, escapeScript + "$&");
  else out += escapeScript;

  // 8. Restore protected script bodies.
  out = out.replace(
    /<script\b([^>]*\bdata-acute-ph="(\d+)"[^>]*)><\/script>/gi,
    (_m: string, attrs: string, idx: string) => {
      const body = scriptBodies[Number(idx)] ?? "";
      return `<script${attrs}>${body}</script>`;
    },
  );

  return out;
}

// ───────────────────────────── error pages ─────────────────────────────────

/** Small, self-contained, dark-card error page (renders inside the iframe). */
function errorPage(reason: string, requestedUrl: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Unable to load page</title><style>` +
    `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#141414;color:#e7e7e7;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `.card{max-width:520px;margin:24px;padding:24px;border:1px solid #2e2e2e;border-radius:12px;` +
    `background:#1c1c1c}.h{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;` +
    `margin:0 0 12px}.dot{width:10px;height:10px;border-radius:50%;background:#FF6B2C;flex:none}` +
    `.url{font:12px/1.5 ui-monospace,Consolas,monospace;color:#9a9a9a;word-break:break-all;` +
    `margin:0 0 12px;padding:8px 10px;background:#111;border-radius:8px}` +
    `.r{margin:0;color:#c9c9c9}.f{margin:16px 0 0;color:#6f6f6f;font-size:12px}</style></head>` +
    `<body><div class="card"><p class="h"><span class="dot"></span>ACUTE embedded browser — unable to load this page</p>` +
    `<p class="url">${escapeHtmlText(requestedUrl)}</p><p class="r">${escapeHtmlText(reason)}</p>` +
    `<p class="f">Try Reload in the browser bar, or use “Open externally”. Proxy limitations are listed in browser-proxy.ts.</p>` +
    `</div></body></html>`
  );
}

// ─────────────────────── upstream fetch machinery ──────────────────────────

interface UpstreamInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | Buffer;
}

/**
 * Manual redirect walk so EVERY hop re-passes the scheme + private-net guard
 * (an upstream redirecting into the LAN must not become our SSRF). Browsers
 * demote POST to GET on 301/302/303; 307/308 preserve method+body.
 */
async function fetchUpstreamGuarded(startUrl: URL, init: UpstreamInit): Promise<Response> {
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  let current = startUrl;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    guardTarget(current);
    const remaining = Math.max(250, deadline - Date.now());
    let response: Response;
    try {
      response = await fetch(current, {
        method,
        headers: init.headers,
        // DOM BodyInit has no Buffer — hand fetch a Uint8Array view/copy.
        body:
          method === "GET" || body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : new Uint8Array(body),
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      throw new ProxyFailure(
        502,
        "UPSTREAM_UNREACHABLE",
        timedOut
          ? `upstream request timed out after ${FETCH_DEADLINE_MS / 1000}s`
          : `upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const location = response.headers.get("location");
    const isRedirect = response.status >= 301 && response.status <= 308 && location !== null;
    if (!isRedirect) return response;
    if (hop === MAX_REDIRECT_HOPS) {
      throw new ProxyFailure(502, "TOO_MANY_REDIRECTS", `more than ${MAX_REDIRECT_HOPS} redirect hops`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ProxyFailure(502, "BAD_REDIRECT", `upstream sent an unparseable redirect to '${location}'`);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    try {
      await response.body?.cancel();
    } catch {
      // draining best-effort only
    }
    current = next;
  }
  /* istanbul ignore next — loop always returns or throws */
  throw new ProxyFailure(502, "TOO_MANY_REDIRECTS", "redirect chain exceeded");
}

/** Reads the body with a hard byte cap (streams when a reader is available). */
async function readCapped(response: Response, capBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > capBytes) {
    throw new ProxyFailure(
      502,
      "RESPONSE_TOO_LARGE",
      `upstream response is ${Math.round(declared / (1024 * 1024))} MiB — over the ${Math.round(capBytes / (1024 * 1024))} MiB proxy cap`,
    );
  }
  const body = response.body;
  if (body !== null) {
    const reader = (
      body as {
        getReader?: () => {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          cancel(): Promise<void>;
        };
      }
    ).getReader?.();
    if (reader !== undefined) {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true || value === undefined) break;
        chunks.push(Buffer.from(value));
        total += value.length;
        if (total > capBytes) {
          try {
            await reader.cancel();
          } catch {
            // best-effort
          }
          throw new ProxyFailure(
            502,
            "RESPONSE_TOO_LARGE",
            `upstream response exceeded the ${Math.round(capBytes / (1024 * 1024))} MiB proxy cap`,
          );
        }
      }
      return Buffer.concat(chunks);
    }
  }
  const whole = Buffer.from(await response.arrayBuffer());
  if (whole.length > capBytes) {
    throw new ProxyFailure(
      502,
      "RESPONSE_TOO_LARGE",
      `upstream response is ${Math.round(whole.length / (1024 * 1024))} MiB — over the ${Math.round(capBytes / (1024 * 1024))} MiB proxy cap`,
    );
  }
  return whole;
}

// ─────────────────────────── reply helpers ─────────────────────────────────

function sendErrorPage(reply: FastifyReply, failure: ProxyFailure, requestedUrl: string): FastifyReply {
  return reply
    .code(failure.status)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(errorPage(`${failure.message} (code ${failure.code})`, requestedUrl));
}

function jsonError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

/** House-style JSON object parse for the routes that overrode the parser. */
function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function historyView(sessionId: string, session: BrowserSession | undefined): unknown {
  if (session === undefined) {
    return { sessionId, entries: [], index: -1, canBack: false, canForward: false };
  }
  return {
    sessionId,
    entries: session.history,
    index: session.index,
    canBack: session.index > 0,
    canForward: session.index < session.history.length - 1,
  };
}

function viewportView(sessionId: string, viewport: BrowserViewport): unknown {
  return { sessionId, viewport };
}

// ────────────────────────── route registration ─────────────────────────────

/**
 * Registers the embedded-browser proxy routes on the given (bearer-scoped)
 * Fastify instance. All mutable state is per-call, so every buildServer()
 * gets a fresh, isolated browser-session store.
 */
export function registerBrowserRoutes(scope: FastifyInstance, token: string): void {
  // Encapsulated CHILD scope — the hook and raw-body content-type parsers
  // below must not leak onto the sibling /api/v1 routes (a scope-wide raw
  // JSON parser would hand every existing POST route a string instead of a
  // parsed object; this broke 10 server tests until encapsulated).
  scope.register((browser) => {
    registerBrowserRoutesInner(browser, token);
  });
}

function registerBrowserRoutesInner(browser: FastifyInstance, token: string): void {
  const store = new SessionStore();

  // iframe navigations cannot send Authorization headers — a valid `bt`
  // ticket is promoted to the real bearer header so the app-level wall
  // passes. Anything else on /browser/proxy gets an HTML error page (it
  // renders inside the iframe); API routes fall through to the normal JSON
  // 401. MUST be registered before the routes (Fastify snapshots hooks).
  const sendProxyAuthPage = (reply: FastifyReply, status: number, reason: string): FastifyReply =>
    reply
      .code(status)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(errorPage(reason, "(iframe navigation)"));

  browser.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization === `Bearer ${token}`) return;
    const rawUrl = request.raw.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const query = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : "");
    const path = (qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl).split("#")[0];
    const session = store.byTicket(query.get("bt") ?? "");
    if (session !== undefined) {
      const claimed = query.get("sessionId");
      if (claimed === null || claimed === session.sessionId) {
        store.refreshTicket(session);
        request.headers = { ...request.headers, authorization: `Bearer ${token}` };
        return;
      }
      if (path === PROXY_PATH) {
        await sendProxyAuthPage(
          reply,
          403,
          `sessionId '${claimed}' does not match the bt ticket's session '${session.sessionId}'.`,
        );
      }
      return;
    }
    if (path === PROXY_PATH) {
      await sendProxyAuthPage(
        reply,
        401,
        "Browser proxy ticket missing, expired or invalid — reopen this browser tab (POST /api/v1/browser/session mints a fresh ticket).",
      );
    }
  });

  // Forms POST from inside the iframe with urlencoded/multipart bodies —
  // parse as raw string/buffer and forward upstream untouched. JSON is taken
  // raw too (re-serialized on forward); our own API routes parse it above.
  browser.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  browser.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  browser.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) =>
    done(null, body),
  );

  // ── POST /browser/session — mint a ticket (the iframe's credential) ──────
  browser.post("/browser/session", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const requested = body.sessionId;
    let sessionId: string;
    if (requested === undefined || requested === null || requested === "") {
      sessionId = `bws_${randomBytes(6).toString("hex")}`;
    } else if (typeof requested !== "string" || !SESSION_ID_RE.test(requested)) {
      return jsonError(
        reply,
        400,
        "VALIDATION",
        "body.sessionId must be alphanumeric/-/./_ and at most 64 chars",
      );
    } else {
      sessionId = requested;
    }
    const session = store.create(sessionId);
    return {
      sessionId: session.sessionId,
      ticket: session.ticket,
      expiresAt: session.ticketExpiresAt,
      history: historyView(session.sessionId, session),
      viewport: session.viewport,
    };
  });

  // ── DELETE /browser/session — drop tab state ─────────────────────────────
  browser.delete("/browser/session", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const sessionId = query.sessionId ?? "";
    if (!SESSION_ID_RE.test(sessionId)) {
      return jsonError(reply, 400, "VALIDATION", "sessionId query param is required");
    }
    if (!store.drop(sessionId)) {
      return jsonError(reply, 404, "NOT_FOUND", `no browser session ${sessionId}`);
    }
    return { ok: true };
  });

  // ── GET/POST /browser/proxy — the workhorse ──────────────────────────────
  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const query = request.query as Record<string, string | undefined>;
    const requestedUrl = query.url ?? "";
    const requestedSession = query.sessionId;
    const bt = query.bt ?? "";

    // Resolve the acting browser session (ticket first — that is the iframe
    // path; header-authed callers may specify any valid sessionId).
    let session: BrowserSession | undefined = bt !== "" ? store.byTicket(bt) : undefined;
    if (session === undefined) {
      if (requestedSession === undefined || !SESSION_ID_RE.test(requestedSession)) {
        return sendErrorPage(
          reply,
          new ProxyFailure(400, "BAD_REQUEST", "missing or invalid ?sessionId= (alphanumeric/-/./_, ≤64 chars)"),
          requestedUrl === "" ? "(no url requested)" : requestedUrl,
        );
      }
      // Header-authed without a ticket: adopt/create the session so the
      // rewritten subresources carry a usable ticket anyway.
      session = store.create(requestedSession);
    } else if (requestedSession !== undefined && requestedSession !== session.sessionId) {
      return sendErrorPage(
        reply,
        new ProxyFailure(403, "TICKET_MISMATCH", "sessionId does not match the bt ticket's session"),
        requestedUrl === "" ? "(no url requested)" : requestedUrl,
      );
    }
    store.refreshTicket(session);

    if (requestedUrl === "") {
      return sendErrorPage(reply, new ProxyFailure(400, "BAD_REQUEST", "missing ?url= parameter"), "(no url requested)");
    }
    let target: URL;
    try {
      target = new URL(requestedUrl);
    } catch {
      return sendErrorPage(
        reply,
        new ProxyFailure(400, "BAD_REQUEST", `'${requestedUrl}' is not a valid absolute URL`),
        requestedUrl,
      );
    }

    try {
      guardTarget(target);
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept:
          (typeof request.headers.accept === "string" && request.headers.accept !== ""
            ? request.headers.accept
            : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
      };
      if (typeof request.headers["accept-language"] === "string" && request.headers["accept-language"] !== "") {
        headers["accept-language"] = request.headers["accept-language"];
      }
      const range = request.headers.range;
      if (typeof range === "string" && range !== "") headers.range = range;

      let init: UpstreamInit = { method: "GET", headers };
      if (request.method === "POST") {
        init = { method: "POST", headers, body: undefined };
        const contentType = request.headers["content-type"];
        if (typeof contentType === "string" && contentType !== "") {
          headers["content-type"] = contentType;
        }
        const raw = request.body;
        if (typeof raw === "string") init.body = raw;
        else if (Buffer.isBuffer(raw)) init.body = raw;
        else if (raw !== undefined && raw !== null) init.body = JSON.stringify(raw);
      }

      const response = await fetchUpstreamGuarded(target, init);

      if (response.status >= 400) {
        return sendErrorPage(
          reply,
          new ProxyFailure(response.status, "UPSTREAM_STATUS", `upstream returned HTTP ${response.status}`),
          requestedUrl,
        );
      }

      const buffer = await readCapped(response, MAX_BODY_BYTES);
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const finalUrl = response.url === "" ? target.toString() : response.url;
      const ctx: RewriteCtx = { pageUrl: finalUrl, sessionId: session.sessionId, ticket: session.ticket };

      const isHtml = /html/i.test(contentType) || /<!doctype html|<html\b/i.test(buffer.subarray(0, 512).toString("utf8"));
      const isCss = !isHtml && /css/i.test(contentType);

      if (isHtml) {
        const rewritten = rewriteHtml(buffer.toString("utf8"), ctx);
        return reply
          .code(response.status === 204 ? 200 : response.status)
          .header("cache-control", "no-store")
          .header("x-acute-final-url", finalUrl)
          .type("text/html; charset=utf-8")
          .send(rewritten);
      }
      if (isCss) {
        const rewritten = rewriteCssText(buffer.toString("utf8"), ctx);
        return reply
          .code(response.status)
          .header("cache-control", "no-store")
          .header("x-acute-final-url", finalUrl)
          .type(contentType)
          .send(rewritten);
      }
      // Binary/media passthrough (Range results keep their 206 + headers).
      reply.code(response.status).header("cache-control", "no-store").type(contentType);
      const contentRange = response.headers.get("content-range");
      if (contentRange !== null) reply.header("content-range", contentRange);
      if (response.headers.get("accept-ranges") !== null) {
        reply.header("accept-ranges", response.headers.get("accept-ranges") as string);
      }
      return reply.send(buffer);
    } catch (error) {
      if (error instanceof ProxyFailure) return sendErrorPage(reply, error, requestedUrl);
      return sendErrorPage(
        reply,
        new ProxyFailure(502, "PROXY_ERROR", `proxy failure: ${error instanceof Error ? error.message : String(error)}`),
        requestedUrl,
      );
    }
  };
  browser.route({
    method: ["GET", "POST"],
    url: "/browser/proxy",
    handler: proxyHandler,
  });

  // ── GET /browser/history — back/forward state for the chrome bar ─────────
  browser.get("/browser/history", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const sessionId = query.sessionId ?? "";
    if (!SESSION_ID_RE.test(sessionId)) {
      return jsonError(reply, 400, "VALIDATION", "sessionId query param is required");
    }
    const session = store.get(sessionId);
    if (session !== undefined) store.touch(sessionId);
    return historyView(sessionId, session);
  });

  // ── POST /browser/navigate — record a navigation or move the pointer ─────
  browser.post("/browser/navigate", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      return jsonError(reply, 400, "VALIDATION", "body.sessionId is required (alphanumeric/-/./_, ≤64 chars)");
    }
    const direction = body.direction;
    if (direction !== undefined && direction !== "back" && direction !== "forward" && direction !== "reload") {
      return jsonError(reply, 400, "VALIDATION", "body.direction must be 'back' | 'forward' | 'reload'");
    }
    const url = body.url;
    const title = body.title;
    if (url !== undefined) {
      let urlOk = false;
      if (typeof url === "string") {
        try {
          const parsed = new URL(url);
          urlOk = parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          urlOk = false;
        }
      }
      if (!urlOk) {
        return jsonError(reply, 400, "VALIDATION", "body.url must be an absolute http(s) URL");
      }
    }
    if (title !== undefined && typeof title !== "string") {
      return jsonError(reply, 400, "VALIDATION", "body.title must be a string");
    }

    const session = store.create(sessionId);

    if (typeof url === "string") {
      const current = session.index >= 0 ? session.history[session.index] : undefined;
      if (current !== undefined && current.url === url) {
        if (typeof title === "string" && title !== "") current.title = title;
        return {
          sessionId,
          action: "title-update",
          entry: current,
          index: session.index,
          canBack: session.index > 0,
          canForward: session.index < session.history.length - 1,
        };
      }
      const entry: HistoryEntry = { url, title: typeof title === "string" && title !== "" ? title : null, ts: Date.now() };
      session.history = session.history.slice(0, session.index + 1);
      session.history.push(entry);
      if (session.history.length > MAX_HISTORY) {
        session.history.shift();
      }
      session.index = session.history.length - 1;
      return {
        sessionId,
        action: "push",
        entry,
        index: session.index,
        canBack: session.index > 0,
        canForward: false,
      };
    }

    if (typeof direction === "string") {
      let nextIndex = session.index;
      if (direction === "back") nextIndex = Math.max(-1, session.index - 1);
      else if (direction === "forward") nextIndex = Math.min(session.history.length - 1, session.index + 1);
      const changed = nextIndex !== session.index;
      session.index = nextIndex;
      const entry = session.index >= 0 ? session.history[session.index] : undefined;
      return {
        sessionId,
        // reload is an explicit command, not a pointer move — always "reload".
        action: direction === "reload" || changed ? direction : "noop",
        entry: entry ?? null,
        index: session.index,
        canBack: session.index > 0,
        canForward: session.index < session.history.length - 1,
      };
    }

    return jsonError(reply, 400, "VALIDATION", "provide either body.url or body.direction");
  });

  // ── GET/PUT /browser/viewport — display-size state (panel + agent tool) ──
  browser.get("/browser/viewport", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const sessionId = query.sessionId ?? "";
    if (!SESSION_ID_RE.test(sessionId)) {
      return jsonError(reply, 400, "VALIDATION", "sessionId query param is required");
    }
    const session = store.get(sessionId);
    return viewportView(sessionId, session === undefined ? DEFAULT_VIEWPORT : session.viewport);
  });

  browser.put("/browser/viewport", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const sessionIdRaw = body.sessionId ?? query.sessionId;
    if (typeof sessionIdRaw !== "string" || !SESSION_ID_RE.test(sessionIdRaw)) {
      return jsonError(reply, 400, "VALIDATION", "sessionId (body or query) is required");
    }

    const session = store.create(sessionIdRaw);
    const next: BrowserViewport = { ...session.viewport };

    const preset = body.preset;
    if (preset !== undefined) {
      if (typeof preset !== "string" || !(preset === "custom" || preset in VIEWPORT_PRESETS)) {
        return jsonError(
          reply,
          400,
          "VALIDATION",
          `body.preset must be one of ${Object.keys(VIEWPORT_PRESETS).join(", ")}, custom (or omitted)`,
        );
      }
      next.preset = preset;
      if (preset !== "custom") {
        next.width = VIEWPORT_PRESETS[preset].width;
        next.height = VIEWPORT_PRESETS[preset].height;
      }
    }
    const width = body.width;
    if (width !== undefined) {
      if (typeof width !== "number" || !Number.isInteger(width) || width < VIEWPORT_MIN_W || width > VIEWPORT_MAX_W) {
        return jsonError(
          reply,
          400,
          "VALIDATION",
          `body.width must be an integer between ${VIEWPORT_MIN_W} and ${VIEWPORT_MAX_W}`,
        );
      }
      next.width = width;
    }
    const height = body.height;
    if (height !== undefined) {
      if (typeof height !== "number" || !Number.isInteger(height) || height < VIEWPORT_MIN_H || height > VIEWPORT_MAX_H) {
        return jsonError(
          reply,
          400,
          "VALIDATION",
          `body.height must be an integer between ${VIEWPORT_MIN_H} and ${VIEWPORT_MAX_H}`,
        );
      }
      next.height = height;
    }
    const zoom = body.zoom;
    if (zoom !== undefined) {
      if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
        return jsonError(reply, 400, "VALIDATION", `body.zoom must be between ${ZOOM_MIN} and ${ZOOM_MAX}`);
      }
      next.zoom = Math.round(zoom * 100) / 100;
    }
    const rotate = body.rotate;
    if (rotate !== undefined) {
      if (typeof rotate !== "boolean") {
        return jsonError(reply, 400, "VALIDATION", "body.rotate must be a boolean");
      }
      next.rotate = rotate;
    }
    // Explicit dims without a preset label → this is a Custom size.
    if (preset === undefined && (width !== undefined || height !== undefined)) next.preset = "custom";

    session.viewport = next;
    return viewportView(sessionIdRaw, next);
  });
}
