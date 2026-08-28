/**
 * ROUND-46 (R46-d) — BROWSER-PROXY COOKIE PERSISTENCE.
 *
 * The R43 embedded browser is a fetch-based URL-rewriting proxy (there is NO
 * browser engine/profile in the sidecar — see browser-proxy.ts), and its v1
 * limitation was blunt: NO cookie handling at all, so every hop upstream was
 * credentially naked and any login-flow site logged the embedded browser out
 * on every page load. This module is the cookie domain logic that closes
 * that gap:
 *
 *   parseSetCookieHeader  — RFC 6265-lite Set-Cookie parsing (name/value,
 *                           Domain/host-only, default-path, Max-Age>Expires,
 *                           ≤0 deletes, hostile-Domain rejection, size guards)
 *   CookieJar             — the per-PROFILE in-memory jar: lazy restore from
 *                           SQLite on first use, ingest on every hop (the
 *                           proxy feeds it EVERY redirect response), Cookie
 *                           header computation per hop, full-replace persist.
 *                           ALL of its operations swallow their own failures:
 *                           cookie bookkeeping must never 502 a page.
 *   load/replace/clear    — the ONLY SQL for the browser_cookies table
 *                           (migration 0017; anti-drift rule, same as every
 *                           other storage module).
 *
 * DURABILITY DESIGN (deliberate, documented): SESSION cookies (no expiry
 * attribute) are stored DURABLY. A real browser keeps them in memory, but
 * this proxy's "browser" IS the sidecar process — an in-memory-only jar
 * would lose logins on every sidecar restart, which is exactly the R43 bug
 * this module exists to fix. Expired rows are dropped at restore AND at
 * save, so the table self-prunes.
 *
 * SECURITY POSTURE (mirrors browser-proxy.ts, kept honest):
 *   - Cookie VALUES never appear in logs, routes, or tool output. There is
 *     no read-back API surface at all — the browser_control get_state shape
 *     is unchanged. The only consumers are the Cookie header we send
 *     upstream and the SQLite rows.
 *   - The proxy still never forwards a CLIENT-supplied Cookie header — the
 *     jar is the single source of truth (a page inside the sandboxed iframe
 *     cannot smuggle cookies into our requests; test-proven).
 *   - Jars never cross profiles: each browser session binds to exactly one
 *     profile (a project id, or "_default" when the mint did not send one).
 *   - Bounded: at most MAX_COOKIES_PER_PROFILE (200) cookies per profile —
 *     past the cap the OLDEST cookie is evicted.
 */
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** RFC 6265 §5.2-ish caps (4 KiB values, sane name length). */
const MAX_NAME_CHARS = 256;
const MAX_VALUE_CHARS = 4_096;

/** Per-profile jar cap — past this, the OLDEST cookie is evicted. */
export const MAX_COOKIES_PER_PROFILE = 200;

/** Sessions minted without a projectId share this profile. */
export const DEFAULT_BROWSER_PROFILE = "_default";

// ───────────────────────── row shape (migration 0017) ───────────────────────

/** One durable cookie row, exactly the browser_cookies table shape. */
export interface StoredBrowserCookie {
  /** Cookie profile: a project id or DEFAULT_BROWSER_PROFILE. */
  projectId: string;
  name: string;
  /** Lowercase host (host-only) or parent domain (Domain-attr), no leading dot. */
  domain: string;
  /** RFC 6265 cookie-path, starts with "/". */
  path: string;
  /** The cookie value — never logged, never routed, never shown. */
  value: string;
  /** ISO 8601 expiry, or null = a durable "session" cookie (by design). */
  expiresAt: string | null;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  /** ISO 8601 insertion time (overwrite keeps the original — RFC 6265 §5.3). */
  storedAt: string;
}

interface CookieRow {
  project_id: string;
  name: string;
  domain: string;
  path: string;
  value: string;
  expires_at: string | null;
  host_only: number;
  secure: number;
  http_only: number;
  stored_at: string;
}

function toStored(row: CookieRow): StoredBrowserCookie {
  return {
    projectId: row.project_id,
    name: row.name,
    domain: row.domain,
    path: row.path,
    value: row.value,
    expiresAt: row.expires_at,
    hostOnly: row.host_only === 1,
    secure: row.secure === 1,
    httpOnly: row.http_only === 1,
    storedAt: row.stored_at,
  };
}

const SELECT_ALL = "SELECT project_id, name, domain, path, value, expires_at, host_only, secure, http_only, stored_at FROM browser_cookies WHERE project_id = ?";

/**
 * Load one profile's cookies, DROPPING expired rows (both from the returned
 * list and from the table — ISO 8601 strings compare lexicographically, so
 * the pruning can happen in SQL). ISO strings are always UTC "Z" here.
 */
export function loadBrowserCookies(db: SqliteDatabase, projectId: string): StoredBrowserCookie[] {
  const nowIso = new Date().toISOString();
  // ISO 8601 UTC strings compare lexicographically, so expiry pruning can
  // happen in SQL — expired rows leave the table at every restore.
  db.prepare("DELETE FROM browser_cookies WHERE project_id = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(
    projectId,
    nowIso,
  );
  const rows = db.prepare(SELECT_ALL).all(projectId) as CookieRow[];
  return rows.map(toStored);
}

/**
 * Full-replace persist: the profile's rows become EXACTLY `cookies`
 * (expired entries are dropped at save — they are never written back), in
 * one transaction. One DELETE + N INSERTs keeps the table identical to the
 * live jar without per-cookie diffing.
 */
export function replaceBrowserCookies(
  db: SqliteDatabase,
  projectId: string,
  cookies: StoredBrowserCookie[],
): void {
  const nowIso = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO browser_cookies (
       project_id, name, domain, path, value, expires_at,
       host_only, secure, http_only, stored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM browser_cookies WHERE project_id = ?").run(projectId);
    for (const cookie of cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= nowIso) continue;
      insert.run(
        projectId,
        cookie.name,
        cookie.domain,
        cookie.path,
        cookie.value,
        cookie.expiresAt,
        cookie.hostOnly ? 1 : 0,
        cookie.secure ? 1 : 0,
        cookie.httpOnly ? 1 : 0,
        cookie.storedAt,
      );
    }
  })();
}

/** Drop every cookie of one profile (data-hygiene helper). */
export function clearBrowserCookies(db: SqliteDatabase, projectId: string): void {
  db.prepare("DELETE FROM browser_cookies WHERE project_id = ?").run(projectId);
}

// ─────────────────────── Set-Cookie parsing (RFC 6265-lite) ─────────────────

/** A parsed Set-Cookie, pre-jar (identity + attributes + computed expiry). */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /**
   * Epoch-ms expiry, or null = durable (no Max-Age/Expires). A value in the
   * past (including the epoch sentinel 0 for Max-Age ≤ 0) means DELETE the
   * matching cookie — the jar interprets it.
   */
  expiresAt: number | null;
}

/** RFC 6265 §5.1.4 default-path: the request URI's directory, or "/". */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash);
}

/**
 * Parse one Set-Cookie header value against the URL that produced it.
 * Returns null when the cookie must be DROPPED entirely: malformed name
 * (no "=" / empty), over the size caps, or a HOSTILE Domain attribute (the
 * request host is neither the Domain nor a subdomain of it, or the Domain
 * is a public-suffix-shaped single label like "com").
 */
export function parseSetCookieHeader(header: string, requestUrl: URL): ParsedSetCookie | null {
  const parts = header.split(";");
  const nameValue = parts[0] ?? "";
  const eq = nameValue.indexOf("=");
  if (eq <= 0) return null; // no "=" or an empty name
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (name === "") return null;
  if (name.length > MAX_NAME_CHARS || value.length > MAX_VALUE_CHARS) return null;

  let domain = requestUrl.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultPath(requestUrl.pathname);
  let secure = false;
  let httpOnly = false;
  let maxAge: number | null = null;
  let expires: number | null = null;

  for (const rawAttr of parts.slice(1)) {
    const attr = rawAttr.trim();
    if (attr === "") continue;
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();

    if (attrName === "domain" && attrValue !== "") {
      const claimed = attrValue.replace(/^\.+/, "").toLowerCase();
      const host = requestUrl.hostname.toLowerCase();
      // Hostile-domain rejection (RFC 6265 §5.3 step 4-5, PSL-free): the
      // host must BE the domain or end with "." + it, and a single-label
      // domain is only acceptable when it IS the host (blocks "com").
      const suffixOk = host === claimed || host.endsWith(`.${claimed}`);
      const publicSuffixShape = !claimed.includes(".") && host !== claimed;
      if (!suffixOk || publicSuffixShape) return null;
      domain = claimed;
      hostOnly = false;
    } else if (attrName === "path" && attrValue !== "") {
      path = attrValue.startsWith("/") ? attrValue : path;
    } else if (attrName === "max-age" && /^-?\d+$/.test(attrValue)) {
      maxAge = Number(attrValue);
    } else if (attrName === "expires") {
      const parsed = Date.parse(attrValue);
      if (!Number.isNaN(parsed)) expires = parsed;
    } else if (attrName === "secure") {
      secure = true;
    } else if (attrName === "httponly") {
      httpOnly = true;
    }
    // samesite/priority/partitioned/unknown attributes: parsed-but-ignored.
  }

  let expiresAt: number | null = null;
  if (maxAge !== null) {
    // Max-Age wins over Expires (RFC 6265 §5.2.2 / §5.3 step 3); ≤ 0 = the
    // epoch sentinel — an already-expired cookie the jar turns into a delete.
    expiresAt = maxAge > 0 ? Date.now() + maxAge * 1000 : 0;
  } else if (expires !== null) {
    expiresAt = expires;
  }

  return { name, value, domain, hostOnly, path, secure, httpOnly, expiresAt };
}

// ─────────────────────────────── the jar ────────────────────────────────────

/** One live cookie in the jar (epoch-ms times; the SQL layer converts). */
export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Epoch ms, or null = durable session cookie (by design). */
  expiresAt: number | null;
  /** Epoch ms insertion time (kept on overwrite — RFC 6265 §5.3 step 11). */
  storedAt: number;
}

function sameIdentity(a: JarCookie, b: JarCookie): boolean {
  return a.name === b.name && a.domain === b.domain && a.path === b.path && a.hostOnly === b.hostOnly;
}

function jarFromStored(row: StoredBrowserCookie): JarCookie {
  return {
    name: row.name,
    value: row.value,
    domain: row.domain,
    hostOnly: row.hostOnly,
    path: row.path,
    secure: row.secure,
    httpOnly: row.httpOnly,
    expiresAt: row.expiresAt === null ? null : Date.parse(row.expiresAt),
    storedAt: Date.parse(row.storedAt),
  };
}

function jarToStored(profileId: string, cookie: JarCookie): StoredBrowserCookie {
  return {
    projectId: profileId,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    expiresAt: cookie.expiresAt === null ? null : new Date(cookie.expiresAt).toISOString(),
    storedAt: new Date(cookie.storedAt).toISOString(),
  };
}

function isExpired(cookie: JarCookie, now: number): boolean {
  return cookie.expiresAt !== null && cookie.expiresAt <= now;
}

/** RFC 6265 §5.1.3 domain-match. */
function domainMatch(host: string, cookie: JarCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatch(requestPath: string, cookiePath: string): boolean {
  const p = requestPath.startsWith("/") ? requestPath : "/";
  const c = cookiePath.startsWith("/") ? cookiePath : "/";
  if (p === c) return true;
  return p.startsWith(c) && (c.endsWith("/") || p.charAt(c.length) === "/");
}

/**
 * The per-profile cookie jar. Created lazily (CookieJarStore.for); the first
 * use restores the profile's durable rows from SQLite. `db` may be
 * undefined (in-memory only — the no-database registration path), in which
 * case restore/persist are no-ops.
 *
 * EVERY public method swallows its own errors: a cookie problem must never
 * turn into a proxy failure (the page still renders; cookies are best
 * effort).
 */
export class CookieJar {
  private cookies: JarCookie[] = [];
  private loaded = false;

  constructor(
    private readonly db: SqliteDatabase | undefined,
    private readonly profileId: string,
    private readonly maxCookies: number = MAX_COOKIES_PER_PROFILE,
  ) {}

  /** Number of live cookies (lazy-loads first; test/introspection only). */
  size(): number {
    this.ensureLoaded();
    this.pruneExpired();
    return this.cookies.length;
  }

  /**
   * Compute the Cookie request header for a URL, or null when nothing
   * matches. RFC 6265 §5.4 order: longer paths first, older cookies first
   * (then name for determinism).
   */
  headerFor(url: URL): string | null {
    try {
      this.ensureLoaded();
      this.pruneExpired();
      const host = url.hostname.toLowerCase();
      const requestPath = url.pathname === "" ? "/" : url.pathname;
      const matched = this.cookies
        .filter((cookie) => domainMatch(host, cookie) && pathMatch(requestPath, cookie.path))
        .filter((cookie) => !cookie.secure || url.protocol === "https:")
        .sort((a, b) => {
          if (b.path.length !== a.path.length) return b.path.length - a.path.length;
          if (a.storedAt !== b.storedAt) return a.storedAt - b.storedAt;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
      if (matched.length === 0) return null;
      return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    } catch {
      return null; // cookie bookkeeping never breaks a fetch
    }
  }

  /**
   * Ingest every Set-Cookie header of a response (used for EVERY hop of a
   * redirect chain — cookies set on intermediate hops are real).
   */
  ingestResponse(url: URL, response: Response): void {
    try {
      for (const header of collectSetCookie(response.headers)) {
        const parsed = parseSetCookieHeader(header, url);
        if (parsed !== null) this.set(parsed);
      }
    } catch {
      /* swallowed by design */
    }
  }

  /** Store/replace/delete one parsed cookie (RFC 6265 §5.3 storage model). */
  set(parsed: ParsedSetCookie): void {
    const now = Date.now();
    const incoming: JarCookie = { ...parsed, storedAt: now };
    // An already-expired Set-Cookie (Max-Age=0 / past Expires) is a DELETE.
    if (isExpired(incoming, now)) {
      this.cookies = this.cookies.filter((cookie) => !sameIdentity(cookie, incoming));
      return;
    }
    // Overwrite keeps the ORIGINAL insertion time (RFC 6265 §5.3 step 11)
    // so refreshes do not game the cap/ordering.
    const existing = this.cookies.find((cookie) => sameIdentity(cookie, incoming));
    if (existing !== undefined) incoming.storedAt = existing.storedAt;
    this.cookies = this.cookies.filter((cookie) => !sameIdentity(cookie, incoming));
    this.cookies.push(incoming);
    // Cap: evict the OLDEST (insertion-time) cookies past the limit.
    while (this.cookies.length > this.maxCookies) {
      let oldestIndex = 0;
      for (let i = 1; i < this.cookies.length; i += 1) {
        if (this.cookies[i].storedAt < this.cookies[oldestIndex].storedAt) oldestIndex = i;
      }
      this.cookies.splice(oldestIndex, 1);
    }
  }

  /**
   * Full-replace persist of the profile's durable rows. Failures are
   * swallowed (the page already rendered; a persist error must never 502
   * one) — worst case the jar survives in memory for this process.
   */
  persist(): void {
    if (this.db === undefined) return;
    try {
      this.pruneExpired();
      replaceBrowserCookies(this.db, this.profileId, this.cookies.map((c) => jarToStored(this.profileId, c)));
    } catch {
      /* swallowed by design */
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.db === undefined) return;
    try {
      const rows = loadBrowserCookies(this.db, this.profileId);
      this.cookies = rows
        .map(jarFromStored)
        .filter((cookie) => !isExpired(cookie, Date.now()));
    } catch {
      this.cookies = []; // unreadable store → an empty, working in-memory jar
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    if (!this.cookies.some((cookie) => isExpired(cookie, now))) return;
    this.cookies = this.cookies.filter((cookie) => !isExpired(cookie, now));
  }
}

/** Headers.getSetCookie() (Node ≥18.14 / undici) with a folded fallback. */
function collectSetCookie(headers: Headers): string[] {
  const getter = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === "function") {
    try {
      return getter.call(headers);
    } catch {
      return [];
    }
  }
  const folded = headers.get("set-cookie");
  if (folded === null) return [];
  // Legacy runtimes fold multiple Set-Cookie lines into one header. Split
  // at commas that start a new name= pair — Expires dates contain commas
  // but never a bare "token=" right after them until the next real cookie.
  return folded.split(/,(?=\s*[^;,=\s]+=)/);
}

/**
 * Per-registration profile → jar map (browser-proxy.ts owns one per
 * server). Jars are created lazily and never shared across profiles.
 */
export class CookieJarStore {
  private readonly jars = new Map<string, CookieJar>();

  constructor(private readonly db: SqliteDatabase | undefined) {}

  for(profileId: string): CookieJar {
    let jar = this.jars.get(profileId);
    if (jar === undefined) {
      jar = new CookieJar(this.db, profileId);
      this.jars.set(profileId, jar);
    }
    return jar;
  }
}
