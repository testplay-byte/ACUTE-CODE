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
 *   GET/POST /api/v1/browser/local-file   ?path=&sessionId=[&bt=]
 *         ROUND-95 (R95-C): disk-backed serving for file:// pages in web dev
 *         mode (the native desktop app renders file:// directly in the child
 *         webview and never calls this). Absolute local path only, ≤10 MiB,
 *         directories refused, HTML/SVG/text/image rendered and everything
 *         else refused honestly; ticket-gated exactly like the proxy.
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
 *   POST   /api/v1/browser-capture         {x, y, w, h} → {pngBase64, width,
 *         height, source} — ROUND-124 (R124): the staged screenshot's
 *         screen-region grab (physical px), run through the SAME standalone
 *         capture backend the browser_control tool uses. 400 VALIDATION for a
 *         malformed/degenerate region, 500 CAPTURE_FAILED on a backend
 *         error. Bearer-authed like /browser-commands (the app itself
 *         calls it mid-command; see the route's comment for the atomicity
 *         rationale). ROUND-125 (R125-A): the reply's `source` field says
 *         WHICH pixels were captured — "window" (Windows PrintWindow on
 *         the app's own child webview — occlusion-proof) or "screen"
 *         (the legacy region grab — another window may occlude it).
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
 *   - Cookie jar (ROUND-46, R46-d): upstream Set-Cookie headers are parsed
 *     (RFC 6265-lite) into a per-PROJECT jar (storage/browser-cookies.ts,
 *     migration 0017) and replayed as a Cookie header on every hop — so
 *     logins now SURVIVE both navigation and a sidecar restart. Client-
 *     supplied Cookie headers are still never forwarded (the jar is the
 *     single source of truth — a page cannot smuggle cookies), our own
 *     bearer/ticket still never leaks to an upstream, and no Set-Cookie is
 *     ever forwarded downstream to the iframe.
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
 *     uploads are forwarded as an opaque buffer (untested). Cookie-backed
 *     login flows now work through the jar (ROUND-46); CORS-dependent
 *     script flows still do not.
 *   - srcset candidates containing commas inside data: URLs are re-merged
 *     heuristically (split-on-comma is what the HTML spec itself does);
 *     pathological base64 payloads may still split wrong.
 *   - Decoding is UTF-8 only (response.text()); legacy charsets mojibake.
 *   - <textarea>/<pre> text that looks like tags could be rewritten —
 *     accepted miss; script bodies are placeholder-protected during the
 *     tag pass precisely to avoid the equivalent (and worse) problem there.
 */
import { randomBytes } from "node:crypto";
// ROUND-95 (R95-C): local-file serving — stat + read for the /browser/
// local-file route and the browser_control read action's file:// branch.
import { readFile as fspReadFile, stat as fspStat } from "node:fs/promises";
import { extname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
// R62 (D8): the live browser command bridge (eval / screenshot-meta results).
import { resolveBrowserCommand } from "./browser-command.js";
// ROUND-124 (R124): the staged browser screenshot's capture engine — the
// decoupled backend door (no computer-use session, no relay, no settings
// gate; the same singleton the browser_control tool's own path uses).
import { getCaptureBackend } from "./computer/backends/index.js";
import { CookieJar, CookieJarStore } from "./storage/browser-cookies.js";
import type { SqliteDatabase } from "./storage/db.js";

// ─────────────────────────── constants ─────────────────────────────────────

const PROXY_PATH = "/api/v1/browser/proxy";

/** ROUND-95 (R95-C): the local-file route — file:// pages in web-dev/proxy
 * mode render through THIS (the native desktop app renders file:// directly
 * in the child webview and never calls it). */
const LOCAL_FILE_PATH = "/api/v1/browser/local-file";

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
  // ROUND-87 (R87, owner: "The default dimensions of the browser on the
  // right sidebar will be set to 1440 by 900"): the desktop preset (the
  // frontend's BROWSER_VIEWPORT_DEFAULT mirrors this exactly).
  width: VIEWPORT_PRESETS.desktop.width,
  height: VIEWPORT_PRESETS.desktop.height,
  preset: "desktop",
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
  /**
   * ROUND-46 (R46-d): the cookie-jar PROFILE this session cooks under — a
   * project id when POST /browser/session carried body.projectId, else
   * "_default". Sticky for the session's lifetime; re-binding only happens
   * when a later mint explicitly sends a projectId. Cookies never cross
   * profiles.
   */
  projectId: string;
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
  /** ROUND-49: the ORIGIN (scheme://host:port, no trailing slash) rewritten
   * sub-resource URLs are stamped with — the sidecar's own address as the
   * requesting client sees it (derived from the live request's Host header).
   *
   * WHY: rewriteHtml injects <base href="UPSTREAM"> so runtime-relative
   * fetches land on the upstream origin. A path-relative rewrite
   * (`/api/v1/browser/proxy?…`) resolves against that BASE — every CSS/JS/
   * img sub-resource was being requested from the UPSTREAM site (which 404s
   * them), so pages rendered as unstyled HTML with no scripts (the owner's
   * round-48 report). Absolute URLs survive the base untouched. Undefined =
   * legacy relative behavior (unit tests / non-HTTP callers). */
  proxyOrigin?: string;
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

/** Throws ProxyFailure for refused schemes / private-network targets.
 * R95-C: file: is still refused HERE — the proxy FETCHES over the network,
 * which a local file is not. The message points at the local-file route. */
function guardTarget(target: URL): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ProxyFailure(
      403,
      "SCHEME_BLOCKED",
      target.protocol === "file:"
        ? "refused scheme 'file:' — the proxy fetches http(s) only; local files render natively in the desktop app's browser (web dev mode: /api/v1/browser/local-file)"
        : `refused scheme '${target.protocol}' — the embedded browser proxies http(s) only`,
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

  /** R62 (D8): every live session (LRU order — most recently used last). */
  list(): BrowserSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Creates or adopts a session, (re)minting its proxy ticket. The cookie
   * profile (projectId) binds on creation and is sticky; an explicit
   * projectId on a re-mint re-binds (the panel knows what it wants).
   *
   * ROTATION: this re-mints the ticket of an existing session, stranding any
   * credential a live iframe still holds — so it is now called ONLY by the
   * POST /browser/session route (the explicit re-mint whose response carries
   * the new ticket, which the panel adopts). Implicit session touches must
   * use getOrCreate() instead (ROUND-48, R48-d).
   */
  create(sessionId: string, projectId?: string): BrowserSession {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.ticketIndex.delete(existing.ticket);
      existing.ticket = mintTicket();
      existing.ticketExpiresAt = Date.now() + TICKET_TTL_MS;
      if (projectId !== undefined) existing.projectId = projectId;
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
      projectId: projectId ?? "_default",
    };
    this.sessions.set(sessionId, session);
    this.ticketIndex.set(session.ticket, sessionId);
    this.evictIfNeeded();
    return session;
  }

  /**
   * ROUND-48 (R48-d): the NON-rotating variant every implicit session touch
   * uses (navigate, viewport, header-authed proxy adoption). Returns the
   * session's EXISTING still-valid ticket — refreshing its TTL — or mints
   * one when the session is unknown or its ticket already expired.
   *
   * Why: rotate-on-touch made every POST /browser/navigate / PUT
   * /browser/viewport mint a ticket the panel never learned (those responses
   * carry no ticket), so the iframe kept building srcs with the now-dead `bt`
   * → the HTML 401 page → the panel's dead-ticket recovery re-minted → its
   * go("reload") POSTed navigate → which rotated the just-minted ticket
   * again → an endless ~0.9-2s flash loop ending in the parked 401 page.
   * Minting here is safe ONLY when no live credential exists (unknown
   * session, or a ticket that already expired past rescue).
   */
  getOrCreate(sessionId: string): BrowserSession {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && existing.ticketExpiresAt > Date.now()) {
      this.refreshTicket(existing);
      this.touch(sessionId);
      return existing;
    }
    // Unknown session (create() mints fresh) or an expired ticket — nobody
    // holds a usable credential, so minting cannot strand a live iframe.
    return this.create(sessionId);
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

  /**
   * Most recently touched session id (the Map's LRU tail — create/touch
   * re-insert, so insertion order IS recency order). "agent" (the tool's
   * fallback id) is skipped when any real tab session exists; returns
   * "agent" itself if it is the only one, else null when empty.
   */
  lastUsedSessionId(): string | null {
    let lastNonAgent: string | null = null;
    let hasAgent = false;
    for (const id of this.sessions.keys()) {
      if (id === "agent") hasAgent = true;
      else lastNonAgent = id;
    }
    return lastNonAgent ?? (hasAgent ? "agent" : null);
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
  // ROUND-49: absolute when the request origin is known — see RewriteCtx.
  // proxyOrigin (survives the injected <base href=upstream>); relative only
  // for legacy callers that never set an origin.
  const origin = ctx.proxyOrigin === undefined ? "" : ctx.proxyOrigin.replace(/\/+$/, "");
  return `${origin}${PROXY_PATH}?${query.toString()}`;
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

// ── ROUND-95 (R95-C): local-file serving (file:// pages) ───────────────────
//
// The owner's report: "I gave it a file path for a local HTML file and after
// giving it that, it gave me this error: 'Native browser unavailable. Only
// HTTP/HTTPS URLs are supported by the embedded browser.'" The NATIVE desktop
// app now renders file:// pages directly in the child webview (Rust gate in
// src-tauri/src/browser.rs). What remains server-side is this thin slice for
// the OTHER mode: in web dev mode (plain browser, no Tauri shell) the panel
// renders through the sidecar, and a file:// navigation needs bytes the
// iframe can load — hence GET/POST /browser/local-file, ticket-gated exactly
// like the proxy. The browser_control `read` action also reads file:// pages
// through the SAME reader (readLocalBrowserFile) so the agent sees the same
// content the user's panel shows.
//
// SECURITY POSTURE (honest):
//   - The route takes an ABSOLUTE LOCAL PATH and reads it from disk. There is
//     no directory-traversal CONTAINMENT by design: the caller is the app's
//     own panel (or the agent's read action), on the owner's own machine, at
//     the same trust level as the approval-gated read_file tool — a browser
//     panel that could open C:\...\index.html but not read it would be a lie.
//   - The browser TICKET gates every request (the same `bt` promotion hook
//     the proxy rides; without it the app-level bearer wall answers 401).
//   - Only NAVIGATION-shaped requests are served (sec-fetch-dest document/
//     iframe, or absent — programmatic clients): a page inside the sandboxed
//     iframe cannot fetch() its SIBLING local files through this route (it
//     can see its own bt in the iframe URL, so the ticket alone is not enough
//     there — dest "empty" is refused). A page CAN still top-level-navigate
//     itself elsewhere within the route; that residual equals the trust of
//     deliberately opening an untrusted local file in any browser, and the
//     shipped NATIVE mode does not use this route at all (file:// pages load
//     in the webview, where file: fetch/XHR is blocked by the engine).
//   - Size cap 10 MiB; directories refused; unknown extensions served as
//     application/octet-stream are REFUSED for the iframe (only HTML, XHTML,
//     SVG, text/* and image/* render — the honest "not a page" answer).

/** Whole-file cap for local reads (the proxy's 25 MiB is for network bodies;
 * a local page is bounded tighter). */
const MAX_LOCAL_FILE_BYTES = 10 * 1024 * 1024;

/** Extension → content-type for the files the browser opens locally. */
const LOCAL_FILE_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** The absolute-path shapes the reader accepts (Windows drive, POSIX, UNC). */
const ABSOLUTE_LOCAL_PATH_RE = /^([a-zA-Z]:[\\/]|\/|\\\\)/;

/** What the iframe may RENDER (everything else is refused honestly — the
 * agent-side `read` action is not bound by this, it just needs text). */
function isRenderableLocalContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.startsWith("image/") ||
    contentType === "application/xhtml+xml"
  );
}

/** True for the types the agent's `read` action returns as TEXT (a binary
 * image read as utf-8 would be mojibake garbage — refuse it honestly). */
export function isTextualLocalContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/xhtml+xml"
  );
}

/** One validated local file ready to serve (route) or decode (read action). */
export interface LocalBrowserFile {
  /** The slash-normalized absolute path the bytes came from. */
  path: string;
  bytes: Buffer;
  contentType: string;
}

export type LocalBrowserFileResult =
  | { ok: true; file: LocalBrowserFile }
  | { ok: false; status: number; code: string; error: string };

/**
 * Reads ONE local file for the browser surface — the /browser/local-file
 * route's engine and the browser_control read action's file:// branch. Every
 * failure is an honest `{status, code, error}` the callers surface verbatim
 * (the route wraps it in the friendly error card; the tool prints it).
 */
export async function readLocalBrowserFile(rawPath: string): Promise<LocalBrowserFileResult> {
  const trimmed = (rawPath ?? "").trim();
  if (trimmed === "") {
    return { ok: false, status: 400, code: "VALIDATION", error: "path is required" };
  }
  if (!ABSOLUTE_LOCAL_PATH_RE.test(trimmed)) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION",
      error: `path must be absolute (a Windows drive like C:\\Users\\me\\page.html, a POSIX path like /home/me/page.html, or a UNC path like \\\\server\\share\\page.html) — got '${trimmed}'`,
    };
  }
  // Windows-style separators fold to "/" (Node accepts them on every
  // platform); a POSIX path is used as-is (a literal backslash in a POSIX
  // filename is legal-but-vanishingly-rare and stays untouched).
  const path = /^[a-zA-Z]:[\\/]|^\\\\/.test(trimmed) ? trimmed.replace(/\\/g, "/") : trimmed;

  let size: number;
  try {
    const stat = await fspStat(path);
    if (!stat.isFile()) {
      return { ok: false, status: 400, code: "NOT_A_FILE", error: `'${trimmed}' is not a file (directories cannot be opened as pages)` };
    }
    size = stat.size;
  } catch (error) {
    return {
      ok: false,
      status: 404,
      code: "FILE_NOT_FOUND",
      error: `'${trimmed}' does not exist or cannot be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (size > MAX_LOCAL_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      error: `'${trimmed}' is ${Math.round(size / (1024 * 1024))} MiB — over the ${Math.round(MAX_LOCAL_FILE_BYTES / (1024 * 1024))} MiB local-file cap`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await fspReadFile(path);
  } catch (error) {
    return {
      ok: false,
      status: 404,
      code: "FILE_NOT_FOUND",
      error: `'${trimmed}' does not exist or cannot be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const contentType = LOCAL_FILE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return { ok: true, file: { path, bytes, contentType } };
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
 *
 * ROUND-46 (R46-d): when a cookie jar is supplied, EVERY hop sends the
 * profile's matching Cookie header (computed per-hop — redirect chains can
 * cross hosts/paths) and EVERY response's Set-Cookie headers are ingested
 * (cookies set on intermediate hops are real). Jar failures are swallowed
 * inside the jar — they can never fail the fetch.
 */
async function fetchUpstreamGuarded(
  startUrl: URL,
  init: UpstreamInit,
  jar?: CookieJar,
): Promise<Response> {
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  let current = startUrl;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    guardTarget(current);
    const hopHeaders: Record<string, string> = { ...init.headers };
    if (jar !== undefined) {
      const cookieHeader = jar.headerFor(current);
      if (cookieHeader !== null) hopHeaders.cookie = cookieHeader;
    }
    const remaining = Math.max(250, deadline - Date.now());
    let response: Response;
    try {
      response = await fetch(current, {
        method,
        headers: hopHeaders,
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
    if (jar !== undefined) jar.ingestResponse(current, response);
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

// ─────────────── shared cores + the agent-tool state API (R43-10) ──────────
//
// The `browser_control` agent tool (tools/index.ts) must read/write the SAME
// per-tab state the /browser/* routes serve — the BrowserPanel PUTs viewport
// over HTTP while the tool calls these functions directly (no self-fetch).
// Routes keep their per-buildServer store (each browser-proxy test server
// starts empty); the most recently REGISTERED store is the tool's target.
// In production exactly one server exists, so tool + panel + routes share one
// store. If no server has booted yet (unit tests), a module store is created
// lazily so the tool still round-trips.

let activeBrowserStore: SessionStore | null = null;

function sharedBrowserStore(): SessionStore {
  if (activeBrowserStore === null) activeBrowserStore = new SessionStore();
  return activeBrowserStore;
}

export interface BrowserNavigateOutcome {
  ok: true;
  sessionId: string;
  action: string;
  entry: HistoryEntry | null;
  index: number;
  canBack: boolean;
  canForward: boolean;
}

export type BrowserNavigateResult = BrowserNavigateOutcome | { ok: false; error: string };

/**
 * Validation + mutation core shared by POST /browser/navigate (HTTP) and the
 * browser_control agent tool (direct call). `body` fields arrive unvalidated
 * (unknown) exactly like the parsed route body; error strings are the API's
 * VALIDATION messages verbatim.
 *
 * ROUND-95 (R95-C): `file:` URLs are VALID navigation targets now — the
 * native browser opens local files, and the panel/the tool normalize local
 * paths into file:// URLs before they ever get here. The proxy FETCH route
 * still refuses file: (guardTarget) — a file navigation renders through the
 * native webview (or, in web dev mode, the /browser/local-file route), never
 * through a server-side fetch.
 */
export function browserNavigateCore(
  store: SessionStore,
  sessionId: string,
  body: { url?: unknown; title?: unknown; direction?: unknown },
): BrowserNavigateResult {
  const direction = body.direction;
  if (direction !== undefined && direction !== "back" && direction !== "forward" && direction !== "reload") {
    return { ok: false, error: "body.direction must be 'back' | 'forward' | 'reload'" };
  }
  const url = body.url;
  const title = body.title;
  if (url !== undefined) {
    let urlOk = false;
    if (typeof url === "string") {
      try {
        const parsed = new URL(url);
        urlOk = parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
      } catch {
        urlOk = false;
      }
    }
    if (!urlOk) return { ok: false, error: "body.url must be an absolute http(s) or file:// URL" };
  }
  if (title !== undefined && typeof title !== "string") {
    return { ok: false, error: "body.title must be a string" };
  }

  // R48-d: getOrCreate — adopting the session for a navigation must NEVER
  // rotate the ticket (the navigate response carries no ticket; a rotation
  // here strands the iframe's credential → 401 flash loop).
  const session = store.getOrCreate(sessionId);

  if (typeof url === "string") {
    const current = session.index >= 0 ? session.history[session.index] : undefined;
    if (current !== undefined && current.url === url) {
      if (typeof title === "string" && title !== "") current.title = title;
      return {
        ok: true,
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
      ok: true,
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
      ok: true,
      sessionId,
      // reload is an explicit command, not a pointer move — always "reload".
      action: direction === "reload" || changed ? direction : "noop",
      entry: entry ?? null,
      index: session.index,
      canBack: session.index > 0,
      canForward: session.index < session.history.length - 1,
    };
  }

  return { ok: false, error: "provide either body.url or body.direction" };
}

export type BrowserViewportResult =
  | { ok: true; sessionId: string; viewport: BrowserViewport }
  | { ok: false; error: string };

/** Validation + mutation core shared by PUT /browser/viewport and the tool. */
export function browserViewportCore(
  store: SessionStore,
  sessionId: string,
  body: { preset?: unknown; width?: unknown; height?: unknown; zoom?: unknown; rotate?: unknown },
): BrowserViewportResult {
  // R48-d: getOrCreate — resizing mid-load must not invalidate the ticket
  // the iframe (and its in-flight subresources) are already using.
  const session = store.getOrCreate(sessionId);
  const next: BrowserViewport = { ...session.viewport };

  const preset = body.preset;
  if (preset !== undefined) {
    if (typeof preset !== "string" || !(preset === "custom" || preset in VIEWPORT_PRESETS)) {
      return {
        ok: false,
        error: `body.preset must be one of ${Object.keys(VIEWPORT_PRESETS).join(", ")}, custom (or omitted)`,
      };
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
      return {
        ok: false,
        error: `body.width must be an integer between ${VIEWPORT_MIN_W} and ${VIEWPORT_MAX_W}`,
      };
    }
    next.width = width;
  }
  const height = body.height;
  if (height !== undefined) {
    if (typeof height !== "number" || !Number.isInteger(height) || height < VIEWPORT_MIN_H || height > VIEWPORT_MAX_H) {
      return {
        ok: false,
        error: `body.height must be an integer between ${VIEWPORT_MIN_H} and ${VIEWPORT_MAX_H}`,
      };
    }
    next.height = height;
  }
  const zoom = body.zoom;
  if (zoom !== undefined) {
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
      return { ok: false, error: `body.zoom must be between ${ZOOM_MIN} and ${ZOOM_MAX}` };
    }
    next.zoom = Math.round(zoom * 100) / 100;
  }
  const rotate = body.rotate;
  if (rotate !== undefined) {
    if (typeof rotate !== "boolean") {
      return { ok: false, error: "body.rotate must be a boolean" };
    }
    next.rotate = rotate;
  }
  // Explicit dims without a preset label → this is a Custom size.
  if (preset === undefined && (width !== undefined || height !== undefined)) next.preset = "custom";

  session.viewport = next;
  return { ok: true, sessionId, viewport: next };
}

/** The `browser_control` tool's get_state: what the user's panel shows now. */
export function browserGetStateCommand(sessionId: string): {
  sessionId: string;
  currentUrl: string | null;
  title: string | null;
  index: number;
  historyLength: number;
  canBack: boolean;
  canForward: boolean;
  viewport: BrowserViewport;
} {
  const session = sharedBrowserStore().get(sessionId);
  if (session === undefined) {
    return {
      sessionId,
      currentUrl: null,
      title: null,
      index: -1,
      historyLength: 0,
      canBack: false,
      canForward: false,
      viewport: { ...DEFAULT_VIEWPORT },
    };
  }
  const entry = session.index >= 0 ? session.history[session.index] : undefined;
  return {
    sessionId,
    currentUrl: entry?.url ?? null,
    title: entry?.title ?? null,
    index: session.index,
    historyLength: session.history.length,
    canBack: session.index > 0,
    canForward: session.index < session.history.length - 1,
    viewport: { ...session.viewport },
  };
}

/** The `browser_control` tool's navigate/back/forward/reload entry point. */
export function browserNavigateCommand(sessionId: string, body: { url?: unknown; title?: unknown; direction?: unknown }): BrowserNavigateResult {
  return browserNavigateCore(sharedBrowserStore(), sessionId, body);
}

/** The `browser_control` tool's set_viewport entry point. */
export function browserViewportCommand(
  sessionId: string,
  body: { preset?: unknown; width?: unknown; height?: unknown; zoom?: unknown; rotate?: unknown },
): BrowserViewportResult {
  return browserViewportCore(sharedBrowserStore(), sessionId, body);
}

/**
 * The browser_control tool's DEFAULT target: the browser tab the user is
 * currently looking at (the panel polls /browser/history, which LRU-touches
 * its session — so the visible tab is the most recently used one). Null when
 * no browser session exists at all.
 */
/**
 * R62 (D8, owner: the agent should be able to "get the status of the
 * things"): every live browser session with its current page + viewport —
 * the `browser_control` get_state `tabs` field. LRU order (the LAST entry
 * is the tab the user is most recently viewing).
 */
export function browserListSessionsCommand(): Array<{
  sessionId: string;
  currentUrl: string | null;
  title: string | null;
  viewport: BrowserViewport;
}> {
  return sharedBrowserStore().list().map((session) => {
    const entry = session.index >= 0 ? session.history[session.index] : undefined;
    return {
      sessionId: session.sessionId,
      currentUrl: entry?.url ?? null,
      title: entry?.title ?? null,
      viewport: { ...session.viewport },
    };
  });
}

export function browserActiveTabSessionId(): string | null {
  return sharedBrowserStore().lastUsedSessionId();
}

// ────────────── ROUND-67 (R67/E3): chat-session → tab bindings ──────────────
//
// The owner's leak report: "I opened a new session in the same project and
// the embedded browser window of the OTHER session was shown / driven."
// Root cause: the tool's default target was the process-global LRU tail —
// whichever tab ANY session touched last — so a new chat session inherited
// (and navigated) the previous session's still-alive browser tab.
//
// The fix is an explicit binding: every CHAT session maps to exactly ONE
// browser tab session. The frontend declares it (POST /browser/bind — the
// panel knows which browser tab is active in the chat session's right-sidebar
// slice, and AgentChatPanel posts it just before a turn starts); when a turn
// runs with NO binding yet, the browser_control tool MINTS a deterministic
// agent tab (ag-<chatSession>) for that chat session and announces it with a
// `browser-open` SSE frame so the sidebar opens a real tab. The binding is
// sticky for the chat session's lifetime; commands in session B can never
// land in session A's tab.

/** chatSessionId → bound browser sessionId. Module-level (survives the
 * session store's LRU eviction — a binding outlives its tab's recency). */
const chatSessionBindings = new Map<string, string>();

/** Validate + normalize a chat-session id for binding keys. */
function toBindingKey(chatSessionId: string): string | null {
  const cleaned = chatSessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return cleaned === "" ? null : cleaned;
}

/** The deterministic agent-tab id a chat session mints when unbound. Stable
 * per chat session (re-minting after a sidecar restart reuses the id). */
export function agentTabIdForChatSession(chatSessionId: string): string | null {
  const key = toBindingKey(chatSessionId);
  return key === null ? null : `ag-${key}`.slice(0, 64);
}

/** Declare (or clear, with null) a chat session's browser-tab binding. */
export function bindChatSession(chatSessionId: string, browserSessionId: string | null): boolean {
  const key = toBindingKey(chatSessionId);
  if (key === null) return false;
  if (browserSessionId === null || browserSessionId === "") {
    chatSessionBindings.delete(key);
    return true;
  }
  if (!SESSION_ID_RE.test(browserSessionId)) return false;
  chatSessionBindings.set(key, browserSessionId);
  return true;
}

/** The chat session's bound browser tab (null when unbound). */
export function browserSessionForChatSession(chatSessionId: string): string | null {
  const key = toBindingKey(chatSessionId);
  if (key === null) return null;
  return chatSessionBindings.get(key) ?? null;
}

/** Test-only: drop every binding. */
export function resetChatSessionBindingsForTest(): void {
  chatSessionBindings.clear();
}

/** Test-only: the full binding map (for assertions). */
export function chatSessionBindingsForTest(): Map<string, string> {
  return chatSessionBindings;
}

/** Test-only: drop all browser-session state (fresh store for the tool tests). */
export function resetBrowserStoreForTest(): void {
  activeBrowserStore = new SessionStore();
  chatSessionBindings.clear();
}

// ────────────────────────── route registration ─────────────────────────────

/**
 * Registers the embedded-browser proxy routes on the given (bearer-scoped)
 * Fastify instance. All mutable state is per-call, so every buildServer()
 * gets a fresh, isolated browser-session store.
 *
 * ROUND-46 (R46-d): `db` (optional — every production caller passes it) is
 * the handle the per-profile cookie jars lazily restore from / persist to
 * (storage/browser-cookies.ts, migration 0017). Without it the jars run
 * in-memory only (the pre-R46 behavior).
 */
export function registerBrowserRoutes(scope: FastifyInstance, token: string, db?: SqliteDatabase): void {
  // Encapsulated CHILD scope — the hook and raw-body content-type parsers
  // below must not leak onto the sibling /api/v1 routes (a scope-wide raw
  // JSON parser would hand every existing POST route a string instead of a
  // parsed object; this broke 10 server tests until encapsulated).
  scope.register((browser) => {
    registerBrowserRoutesInner(browser, token, db);
  });
}

function registerBrowserRoutesInner(browser: FastifyInstance, token: string, db: SqliteDatabase | undefined): void {
  const store = new SessionStore();
  // R43-10 tool wave: the latest booted server's store is what the
  // browser_control agent tool operates on (see sharedBrowserStore above).
  activeBrowserStore = store;
  // ROUND-46 (R46-d): per-registration cookie-jar store — profileId → jar,
  // backed by this server's db when one was passed.
  const jars = new CookieJarStore(db);

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
      // R95-C: the local-file route renders inside the iframe like the
      // proxy — its auth failures must be HTML pages too.
      if (path === PROXY_PATH || path === LOCAL_FILE_PATH) {
        await sendProxyAuthPage(
          reply,
          403,
          `sessionId '${claimed}' does not match the bt ticket's session '${session.sessionId}'.`,
        );
      }
      return;
    }
    if (path === PROXY_PATH || path === LOCAL_FILE_PATH) {
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
    // ROUND-46 (R46-d) → ROUND-67 (R67/E4) WIRED: the BrowserPanel now sends
    // its projectId on every mint — sessions of different projects no longer
    // share the "_default" cookie profile (logins stay project-scoped).
    const requestedProject = body.projectId;
    let projectId: string | undefined;
    if (requestedProject !== undefined && requestedProject !== null && requestedProject !== "") {
      if (typeof requestedProject !== "string" || !SESSION_ID_RE.test(requestedProject)) {
        return jsonError(
          reply,
          400,
          "VALIDATION",
          "body.projectId must be alphanumeric/-/./_ and at most 64 chars",
        );
      }
      projectId = requestedProject;
    }
    const session = store.create(sessionId, projectId);
    return {
      sessionId: session.sessionId,
      ticket: session.ticket,
      expiresAt: session.ticketExpiresAt,
      history: historyView(session.sessionId, session),
      viewport: session.viewport,
    };
  });

  // ── DELETE /browser/session — drop tab state ─────────────────────────────
  // ROUND-46 (R46-d): the session's COOKIE JAR deliberately survives this —
  // closing a browser tab is not logging out (a re-minted session of the
  // same profile continues its logins; restart-safe by design).
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

  // ── POST /browser/bind — ROUND-67 (R67/E3): declare a chat session's tab ──
  // The frontend (AgentChatPanel, just before a turn starts) posts the
  // browser session of the chat session's ACTIVE right-sidebar browser tab
  // (or null to clear). The browser_control tool then targets exactly that
  // tab for the whole turn — the cross-session leak fix. Body:
  // {chatSessionId: string, sessionId: string|null}.
  browser.post("/browser/bind", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const chatSessionId = body.chatSessionId;
    if (typeof chatSessionId !== "string" || chatSessionId === "") {
      return jsonError(reply, 400, "VALIDATION", "body.chatSessionId is required");
    }
    const bound = body.sessionId;
    if (bound !== undefined && bound !== null && typeof bound !== "string") {
      return jsonError(reply, 400, "VALIDATION", "body.sessionId must be a string or null");
    }
    if (!bindChatSession(chatSessionId, typeof bound === "string" ? bound : null)) {
      return jsonError(
        reply,
        400,
        "VALIDATION",
        "body.sessionId must be alphanumeric/-/./_ and at most 64 chars",
      );
    }
    return { ok: true, chatSessionId, sessionId: typeof bound === "string" ? bound : null };
  });

  // ── GET/POST /browser/proxy — the workhorse ──────────────────────────────
  /**
   * ROUND-49: is this request a NAVIGATION (the iframe itself: an HTML
   * document the user sees — errors render as the friendly HTML error page)
   * or a SUB-RESOURCE (css/js/img/font the rewritten page pulled in — errors
   * must be an EMPTY body of the upstream's content-type, or the browser
   * parses our HTML error markup as CSS/JS and spews console noise)?
   * sec-fetch-dest is the modern signal ("document"/"iframe" = navigation);
   * the Accept header is the fallback (navigations always offer text/html).
   */
  const wantsHtmlErrorPage = (request: FastifyRequest): boolean => {
    const dest = request.headers["sec-fetch-dest"];
    if (typeof dest === "string") return dest === "document" || dest === "iframe";
    const accept = request.headers.accept;
    if (typeof accept === "string" && accept !== "") return /text\/html/i.test(accept);
    return true; // no signals at all — assume navigation (safe default)
  };

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
      // rewritten subresources carry a usable ticket anyway. R48-d:
      // getOrCreate — adopting must not rotate the session's live ticket.
      session = store.getOrCreate(requestedSession);
    } else if (requestedSession !== undefined && requestedSession !== session.sessionId) {
      return sendErrorPage(
        reply,
        new ProxyFailure(403, "TICKET_MISMATCH", "sessionId does not match the bt ticket's session"),
        requestedUrl === "" ? "(no url requested)" : requestedUrl,
      );
    }
    store.refreshTicket(session);
    // ROUND-46 (R46-d): the session's cookie profile decides which jar this
    // request cooks under (projectId-bound or the shared "_default").
    const jar = jars.for(session.projectId);

    // ROUND-49: the sidecar's origin AS THIS CLIENT SEES IT (Host header —
    // the same address the iframe navigation used). Every rewritten
    // sub-resource URL is stamped with it so the injected
    // <base href="upstream"> cannot hijack them onto the upstream origin.
    // No Host header (HTTP/1.0 oddity) → leave undefined → relative rewrites
    // (legacy behavior, still correct for the iframe's own document).
    const hostHeader = request.headers.host;
    const proxyOrigin =
      typeof hostHeader === "string" && hostHeader !== ""
        ? `${request.protocol}://${hostHeader}`
        : undefined;
    const htmlErrors = wantsHtmlErrorPage(request);

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

      // ROUND-46 (R46-d): the jar rides the whole hop chain — Cookie header
      // replayed per hop, Set-Cookie ingested per hop. Persisted afterwards
      // (in a finally — cookies from a chain that ultimately failed are
      // still real) with every failure swallowed inside the jar.
      let response: Response;
      try {
        response = await fetchUpstreamGuarded(target, init, jar);
      } finally {
        jar.persist();
      }

      if (response.status >= 400) {
        // ROUND-49: sub-resources get an EMPTY body with the upstream status
        // (an HTML error page in place of a stylesheet/script is parse noise
        // in the console and can masquerade as content); navigations keep the
        // friendly error card.
        if (!htmlErrors) {
          const upstreamType = response.headers.get("content-type");
          return reply
            .code(response.status)
            .header("cache-control", "no-store")
            .type(upstreamType ?? "application/octet-stream")
            .send(Buffer.alloc(0));
        }
        return sendErrorPage(
          reply,
          new ProxyFailure(response.status, "UPSTREAM_STATUS", `upstream returned HTTP ${response.status}`),
          requestedUrl,
        );
      }

      const buffer = await readCapped(response, MAX_BODY_BYTES);
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const finalUrl = response.url === "" ? target.toString() : response.url;
      const ctx: RewriteCtx = {
        pageUrl: finalUrl,
        sessionId: session.sessionId,
        ticket: session.ticket,
        ...(proxyOrigin !== undefined ? { proxyOrigin } : {}),
      };

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
      // ROUND-115 note (the pinned round-115 table): there is NO file
      // download path in this proxy today — bytes stream to the panel's
      // iframe in memory and nothing is written to disk. When a "save this
      // download" affordance lands, its save location is pinned:
      // <projectRoot>/downloads/, created on demand (mkdirSync recursive —
      // the tools/fs-ops.ts writeFile pattern), the twin of uploads =
      // <root>/attachments/ (routes/attachments.ts).
      reply.code(response.status).header("cache-control", "no-store").type(contentType);
      const contentRange = response.headers.get("content-range");
      if (contentRange !== null) reply.header("content-range", contentRange);
      if (response.headers.get("accept-ranges") !== null) {
        reply.header("accept-ranges", response.headers.get("accept-ranges") as string);
      }
      return reply.send(buffer);
    } catch (error) {
      if (error instanceof ProxyFailure) {
        // ROUND-49: sub-resource fetch failures (502/timeout/size) also get
        // the empty-body treatment — see wantsHtmlErrorPage.
        if (!htmlErrors && (error.status === 502 || error.status === 504)) {
          return reply
            .code(error.status)
            .header("cache-control", "no-store")
            .type("application/octet-stream")
            .send(Buffer.alloc(0));
        }
        return sendErrorPage(reply, error, requestedUrl);
      }
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

  // ── GET/POST /browser/local-file — R95-C: file:// pages in web dev mode ─
  // The panel's iframe loads a local file through THIS route when the native
  // webview is absent (web dev mode / e2e); the native desktop app never
  // calls it (file:// renders in the child webview directly). The auth story
  // is the proxy's: the `bt` ticket promotes to bearer (the hook above), a
  // missing/expired one renders the same HTML 401 card. POST answers like GET
  // — a static file has no server-side code, so a self-targeting form inside
  // a local page simply reloads the page (the honest behavior for a static
  // document).
  const localFileHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const query = request.query as Record<string, string | undefined>;
    const requestedPath = query.path ?? "";

    // Navigation-shape guard (see the security post above): sec-fetch-dest
    // document/iframe is the iframe loading the page; ABSENT means a
    // programmatic caller (tests, the app's own fetches); anything else
    // (fetch/XHR send dest "empty") is a page trying to read OTHER local
    // files through its own ticket — refused.
    const dest = request.headers["sec-fetch-dest"];
    if (typeof dest === "string" && dest !== "document" && dest !== "iframe") {
      return sendErrorPage(
        reply,
        new ProxyFailure(
          403,
          "NOT_A_NAVIGATION",
          "the local-file route serves browser navigations only — a page cannot fetch other local files through it",
        ),
        requestedPath === "" ? "(no path requested)" : requestedPath,
      );
    }

    const read = await readLocalBrowserFile(requestedPath);
    if (!read.ok) {
      return sendErrorPage(reply, new ProxyFailure(read.status, read.code, read.error), requestedPath);
    }
    const { file } = read;
    if (!isRenderableLocalContentType(file.contentType)) {
      return sendErrorPage(
        reply,
        new ProxyFailure(
          415,
          "UNRENDERABLE_TYPE",
          `'${file.path}' is a ${file.contentType} file — the browser panel renders HTML, SVG, text and image files (the desktop app's native browser opens it properly)`,
        ),
        requestedPath,
      );
    }
    // R95-C: UNC paths ("//server/share/x") take the TWO-slash host form
    // (`file://server/share/x`); local paths get three. The header is
    // informational (nothing consumes it yet), but it must stay a shape
    // the WHATWG parser round-trips.
    const finalFileUrl = file.path.startsWith("//")
      ? `file:${file.path}`
      : `file://${file.path.startsWith("/") ? "" : "/"}${file.path}`;
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("x-acute-final-url", finalFileUrl)
      .type(file.contentType)
      .send(file.bytes);
  };
  browser.route({
    method: ["GET", "POST"],
    url: "/browser/local-file",
    handler: localFileHandler,
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
    // Shared core (also drives the browser_control agent tool directly).
    const result = browserNavigateCore(store, sessionId, body);
    if (!result.ok) return jsonError(reply, 400, "VALIDATION", result.error);
    // Strip the internal ok flag — the HTTP contract is exactly the R43-10 shape.
    const { ok: _ok, ...payload } = result;
    return payload;
  });

  // ── R62 (D8): POST /browser-commands/:commandId/result — the UI's answer
  // to a live browser command (the eval / screenshot-meta round trip; see
  // browser-command.ts). Bearer-authed like every other /browser route
  // (tickets never apply here — the PANEL calls it with the header).
  // 204 on success; 404 for unknown/expired command ids (the panel treats
  // that as fire-and-forget); the command itself resolves or rejects the
  // pending agent tool promise.
  browser.post("/browser-commands/:commandId/result", async (request: FastifyRequest, reply: FastifyReply) => {
    const { commandId } = request.params as { commandId?: string };
    if (typeof commandId !== "string" || commandId === "") {
      return jsonError(reply, 400, "VALIDATION", "commandId path param is required");
    }
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const resolved = resolveBrowserCommand(commandId, {
      ok: body.ok,
      data: body.data,
      error: body.error,
    });
    if (!resolved) {
      return jsonError(reply, 404, "NOT_FOUND", `unknown or expired browser command '${commandId}'`);
    }
    return reply.code(204).send();
  });

  // ── ROUND-124 (R124): POST /browser-capture — the staged screenshot's ────
  // screen-region grab. The app's screenshot_capture choreography (the
  // BrowserPanel handler, or the module-level bridge fallback when no panel
  // is mounted — the owner in Settings) re-stages the tab's webview at the
  // FIXED capture resolution, then calls THIS with the staged region in
  // PHYSICAL screen px; we run the SAME standalone capture engine the
  // browser_control tool's own screenshot action uses (getCaptureBackend —
  // GDI CopyFromScreen on Windows, scrot -a on Linux, screencapture -R on
  // macOS; no computer-use session, no relay, no settings gate) and answer
  // the PNG bytes. The whole stage → grab → restore dance stays ATOMIC
  // inside the frontend's command handler because the webview must be
  // re-staged for exactly the duration of THIS grab — a two-command protocol
  // (stage / capture / unstage from the tool side) could leak the staging if
  // any leg died mid-flight.
  //
  // TRUST: called by the app itself, bearer-authed exactly like the
  // /browser-commands result route beside it (the token holder is the app —
  // the same trust level every other capture-capable surface already has).
  // Validation: x/y finite, w/h finite and within the REGION floor (50px,
  // the tool's REGION_MIN_PX twin — a degenerate region is refused, never
  // captured) and a sane ceiling (the 8K band — a stray number must never
  // allocate a gigabyte bitmap in the backend capsule).
  browser.post("/browser-capture", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseJsonObject(request.body);
    if (body === null) return jsonError(reply, 400, "VALIDATION", "body must be a JSON object");
    const x = body.x;
    const y = body.y;
    const w = body.w;
    const h = body.h;
    if (
      typeof x !== "number" || !Number.isFinite(x) ||
      typeof y !== "number" || !Number.isFinite(y) ||
      typeof w !== "number" || !Number.isFinite(w) ||
      typeof h !== "number" || !Number.isFinite(h)
    ) {
      return jsonError(reply, 400, "VALIDATION", "body.x/y/w/h must be finite numbers (the physical screen region to capture)");
    }
    if (w < 50 || h < 50) {
      return jsonError(reply, 400, "VALIDATION", `region ${Math.round(w)}×${Math.round(h)}px is below the 50px floor — a degenerate region is never captured`);
    }
    if (w > 7680 || h > 4320) {
      return jsonError(reply, 400, "VALIDATION", `region ${Math.round(w)}×${Math.round(h)}px exceeds the 7680×4320 ceiling`);
    }
    const capture = getCaptureBackend();
    // ── ROUND-125 (R125-A): the OWNER PID ── the sidecar is a CHILD of the
    // Tauri app (process.ppid IS the app's pid on the owner's machine), and
    // the Windows backend's PrintWindow path uses it to resolve the app's
    // top-level window → the staged CHILD webview, capturing the WINDOW'S
    // OWN SURFACE instead of scraping the screen region (the owner's
    // occlusion verdict — another application's pixels were leaking into
    // the grab). Dev shells (npm run / a terminal) parent us to a NON-APP
    // pid: the finite-positive-int check filters only garbage here — a
    // wrong-but-valid pid simply finds no owner window and the backend's
    // honest screen fallback answers (source:"screen"). Old sidecars↔new
    // apps are unaffected: the field is additive on both ends.
    const ownerPid =
      typeof process.ppid === "number" && Number.isInteger(process.ppid) && process.ppid > 0
        ? process.ppid
        : undefined;
    const raster = await capture.backend.captureRegion(capture.run, {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      ...(ownerPid !== undefined ? { ownerPid } : {}),
    });
    if ("error" in raster) {
      return jsonError(reply, 500, "CAPTURE_FAILED", `screen capture failed: ${raster.error}`);
    }
    if (typeof raster.pngBase64 !== "string" || raster.pngBase64.length < 64) {
      return jsonError(reply, 500, "CAPTURE_FAILED", "the capture backend produced no image");
    }
    // R125-A: `source` rides the reply (additive — old frontends ignore it;
    // an old SIDECAR never sets it, and absence reads as the conservative
    // "screen"). The frontend threads it into the screenshot_capture
    // command reply so the tool's note can say WHICH pixels it got.
    return {
      pngBase64: raster.pngBase64,
      width: raster.width,
      height: raster.height,
      source: raster.source === "window" ? "window" : "screen",
    };
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

    // Shared core (also drives the browser_control agent tool directly).
    const result = browserViewportCore(store, sessionIdRaw, body);
    if (!result.ok) return jsonError(reply, 400, "VALIDATION", result.error);
    return viewportView(sessionIdRaw, result.viewport);
  });
}
