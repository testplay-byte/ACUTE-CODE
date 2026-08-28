/**
 * ROUND-46 (R46-d) — browser-proxy COOKIE PERSISTENCE tests.
 *
 * Unit coverage for agent-core/src/storage/browser-cookies.ts (the module
 * the proxy's per-profile cookie jars are built on):
 *   - parseSetCookieHeader: RFC 6265-lite — name/value, Domain/host-only,
 *     default-path derivation, Max-Age>Expires precedence, ≤0 deletes,
 *     hostile-Domain rejection, size guards;
 *   - CookieJar: matching (domain/path/secure), overwrite + delete, the
 *     200/profile cap (oldest evicted), lazy expiry pruning;
 *   - the SQLite layer (migration 0017): full-replace round-trip, expired
 *     rows dropped at save AND restore, profiles never cross.
 *
 * The ROUTE-level behavior (replay through the proxy, hop ingestion,
 * restart survival, DELETE-keeps-cookies) lives in browser-proxy.test.ts.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieJar,
  loadBrowserCookies,
  parseSetCookieHeader,
  replaceBrowserCookies,
  type ParsedSetCookie,
} from "../src/storage/browser-cookies";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const dir = mkdtempSync(join(tmpdir(), "acute-browser-cookies-"));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows file-handle lag)
  }
});

/** Parse + feed one Set-Cookie into a jar (fails the test when unparseable). */
function feed(jar: CookieJar, header: string, url: string): ParsedSetCookie | null {
  const parsed = parseSetCookieHeader(header, new URL(url));
  if (parsed !== null) jar.set(parsed);
  return parsed;
}

// ── parseSetCookieHeader ────────────────────────────────────────────────────

describe("parseSetCookieHeader (RFC 6265-lite)", () => {
  it("parses the name/value pair with host-only defaults (request host, default path, durable)", () => {
    const parsed = parseSetCookieHeader("sid=abc123", new URL("https://a.example/app/page"));
    expect(parsed).toMatchObject({
      name: "sid",
      value: "abc123",
      domain: "a.example",
      hostOnly: true,
      path: "/app",
      secure: false,
      httpOnly: false,
      expiresAt: null,
    });
  });

  it("derives the default-path from the request URI (dir, root, and single-segment shapes)", () => {
    expect(parseSetCookieHeader("a=1", new URL("https://x.example/"))?.path).toBe("/");
    expect(parseSetCookieHeader("a=1", new URL("https://x.example"))?.path).toBe("/");
    expect(parseSetCookieHeader("a=1", new URL("https://x.example/deep/dir/page.html"))?.path).toBe("/deep/dir");
    // A path attribute that is not absolute is ignored → default-path stands.
    expect(parseSetCookieHeader("a=1; Path=relative", new URL("https://x.example/deep/dir/page.html"))?.path).toBe(
      "/deep/dir",
    );
  });

  it("turns a Domain attribute into a parent-domain cookie (dot stripped, case-insensitive)", () => {
    const parsed = parseSetCookieHeader("sid=1; Domain=.Example.COM; Path=/", new URL("https://app.example.com/"));
    expect(parsed).toMatchObject({ domain: "example.com", hostOnly: false, path: "/" });
  });

  it("rejects hostile Domain attributes entirely (unrelated host, public-suffix shape)", () => {
    // site.example is neither example.com nor a subdomain of it.
    expect(parseSetCookieHeader("sid=1; Domain=evil.com", new URL("https://site.example/"))).toBeNull();
    // Single-label domains are only acceptable when they ARE the host —
    // "com" against example.com is the public-suffix shape.
    expect(parseSetCookieHeader("sid=1; Domain=com", new URL("https://example.com/"))).toBeNull();
    // But a single-label Domain that equals the host (intranet "localhost")
    // is a legitimate host-match.
    expect(parseSetCookieHeader("sid=1; Domain=localhost", new URL("http://localhost:5173/"))).toMatchObject({
      domain: "localhost",
      hostOnly: false,
    });
  });

  it("accepts a subdomain host for a Domain cookie", () => {
    const parsed = parseSetCookieHeader("sid=1; Domain=site.example", new URL("https://a.b.site.example/x"));
    expect(parsed).toMatchObject({ domain: "site.example", hostOnly: false });
  });

  it("prefers Max-Age over Expires, and Max-Age ≤ 0 is the epoch delete sentinel", () => {
    const before = Date.now();
    const maxAge = parseSetCookieHeader(
      "k=v; Max-Age=100; Expires=Wed, 09 Jun 2100 10:18:14 GMT",
      new URL("https://x.example/"),
    );
    expect(maxAge?.expiresAt).toBeGreaterThanOrEqual(before + 100_000);
    expect(maxAge?.expiresAt).toBeLessThanOrEqual(Date.now() + 100_000);
    expect(parseSetCookieHeader("k=v; Max-Age=0", new URL("https://x.example/"))?.expiresAt).toBe(0);
    expect(parseSetCookieHeader("k=v; Max-Age=-1", new URL("https://x.example/"))?.expiresAt).toBe(0);
  });

  it("parses Expires dates and ignores unparseable ones (durable fallback)", () => {
    expect(parseSetCookieHeader("k=v; Expires=Wed, 09 Jun 2100 10:18:14 GMT", new URL("https://x.example/"))?.expiresAt).toBe(
      Date.parse("Wed, 09 Jun 2100 10:18:14 GMT"),
    );
    expect(parseSetCookieHeader("k=v; Expires=not-a-date", new URL("https://x.example/"))?.expiresAt).toBeNull();
  });

  it("drops malformed and oversized cookies (no '=', empty name, name>256, value>4096)", () => {
    expect(parseSetCookieHeader("novalue", new URL("https://x.example/"))).toBeNull();
    expect(parseSetCookieHeader("=v", new URL("https://x.example/"))).toBeNull();
    expect(parseSetCookieHeader(`${"n".repeat(257)}=v`, new URL("https://x.example/"))).toBeNull();
    expect(parseSetCookieHeader(`k=${"v".repeat(4097)}`, new URL("https://x.example/"))).toBeNull();
    // Flags + unknown attributes parse; value keeps its quotes verbatim.
    expect(parseSetCookieHeader('q="v"; Secure; HttpOnly; SameSite=Lax', new URL("https://x.example/"))).toMatchObject({
      value: '"v"',
      secure: true,
      httpOnly: true,
    });
  });
});

// ── CookieJar ───────────────────────────────────────────────────────────────

describe("CookieJar (matching, overwrite, cap, pruning)", () => {
  it("sends cookies only to matching host+path (domain cookies subdomain-wide, host-only exact)", () => {
    const jar = new CookieJar(undefined, "_default");
    expect(feed(jar, "hostonly=1", "https://a.example/app/page")).not.toBeNull();
    expect(feed(jar, "wide=2; Domain=a.example; Path=/app", "https://a.example/app/other")).not.toBeNull();
    expect(feed(jar, "root=3; Path=/", "https://a.example/")).not.toBeNull();

    expect(jar.headerFor(new URL("https://a.example/app/page"))).toBe("hostonly=1; wide=2; root=3");
    // Subdomain: only the DOMAIN cookie applies (host-only never leaks down).
    expect(jar.headerFor(new URL("https://sub.a.example/app/page"))).toBe("wide=2");
    // Path boundary: /app cookie matches /app/... but NOT /apple or /other.
    expect(jar.headerFor(new URL("https://a.example/apple"))).toBe("root=3");
    expect(jar.headerFor(new URL("https://a.example/other"))).toBe("root=3");
    // Different host entirely.
    expect(jar.headerFor(new URL("https://b.example/app/page"))).toBeNull();
  });

  it("sends Secure cookies only over https", () => {
    const jar = new CookieJar(undefined, "_default");
    expect(feed(jar, "s=1; Secure", "https://a.example/")).not.toBeNull();
    expect(jar.headerFor(new URL("https://a.example/"))).toBe("s=1");
    expect(jar.headerFor(new URL("http://a.example/"))).toBeNull();
  });

  it("overwrites the same identity (one row) and Max-Age=0 deletes it", () => {
    const jar = new CookieJar(undefined, "_default");
    feed(jar, "sid=one", "https://a.example/");
    feed(jar, "sid=two", "https://a.example/");
    expect(jar.size()).toBe(1);
    expect(jar.headerFor(new URL("https://a.example/"))).toBe("sid=two");
    // Same name on a DIFFERENT identity (domain cookie) is a second cookie.
    feed(jar, "sid=three; Domain=a.example", "https://a.example/");
    expect(jar.size()).toBe(2);
    // Max-Age=0 on the host-only identity deletes exactly that one.
    feed(jar, "sid=x; Max-Age=0", "https://a.example/");
    expect(jar.headerFor(new URL("https://a.example/"))).toBe("sid=three");
    expect(jar.size()).toBe(1);
  });

  it("caps the jar per profile, evicting the OLDEST cookie", () => {
    const jar = new CookieJar(undefined, "_default", 3);
    feed(jar, "c1=1", "https://a.example/");
    feed(jar, "c2=2", "https://a.example/");
    feed(jar, "c3=3", "https://a.example/");
    feed(jar, "c4=4", "https://a.example/");
    expect(jar.size()).toBe(3);
    const header = jar.headerFor(new URL("https://a.example/"));
    expect(header).toContain("c4=4");
    expect(header).not.toContain("c1=1"); // oldest evicted
    expect(header).toContain("c2=2");
  });

  it("prunes expired cookies lazily (not sent, gone from the jar)", () => {
    vi.useFakeTimers();
    try {
      const jar = new CookieJar(undefined, "_default");
      feed(jar, "temp=1; Max-Age=60", "https://a.example/");
      feed(jar, "keep=2", "https://a.example/");
      // Frozen clock → equal storedAt → the deterministic name tie-break.
      expect(jar.headerFor(new URL("https://a.example/"))).toBe("keep=2; temp=1");
      vi.advanceTimersByTime(120_000); // two minutes later the Max-Age lapsed
      expect(jar.headerFor(new URL("https://a.example/"))).toBe("keep=2");
      expect(jar.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── persistence (migration 0017) ────────────────────────────────────────────

describe("cookie persistence (browser_cookies table)", () => {
  let db: SqliteDatabase;

  afterEach(() => {
    db.close();
  });

  function freshDb(): SqliteDatabase {
    db = openDatabase(join(dir, `${randomUUID()}.db`));
    return db;
  }

  it("round-trips through SQLite: persist is a full replace, restore feeds a fresh jar", () => {
    const database = freshDb();
    const first = new CookieJar(database, "prj_a");
    feed(first, "durable=1", "https://a.example/app");
    feed(first, "timed=2; Max-Age=3600; Secure", "https://a.example/");
    first.persist();

    // A brand-new jar on the same db + profile restores everything (this is
    // the sidecar-restart survival path).
    const second = new CookieJar(database, "prj_a");
    expect(second.headerFor(new URL("https://a.example/app"))).toBe("durable=1; timed=2");
    // Full replace: drop one cookie, persist, restore → exactly the new set.
    feed(second, "timed=x; Max-Age=0", "https://a.example/");
    second.persist();
    const third = new CookieJar(database, "prj_a");
    expect(third.headerFor(new URL("https://a.example/app"))).toBe("durable=1");
  });

  it("drops expired rows at save AND at restore", () => {
    const database = freshDb();
    vi.useFakeTimers();
    try {
      const jar = new CookieJar(database, "prj_b");
      feed(jar, "short=1; Max-Age=60", "https://b.example/");
      jar.persist();
      expect(loadBrowserCookies(database, "prj_b")).toHaveLength(1);
      vi.advanceTimersByTime(120_000);
      // Save-side drop: the expired cookie is pruned before writing, so the
      // full replace leaves the table empty (not even a dead row).
      jar.persist();
      expect(loadBrowserCookies(database, "prj_b")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }

    // Restore-side drop: a stale expired row planted by hand is deleted from
    // the table by the very next load.
    database
      .prepare(
        `INSERT INTO browser_cookies (project_id, name, domain, path, value, expires_at, host_only, secure, http_only, stored_at)
         VALUES ('prj_b', 'zombie', 'b.example', '/', 'x', '2000-01-01T00:00:00.000Z', 1, 0, 0, '2000-01-01T00:00:00.000Z')`,
      )
      .run();
    const restored = loadBrowserCookies(database, "prj_b");
    expect(restored.map((c) => c.name)).not.toContain("zombie");
    const remaining = database
      .prepare("SELECT COUNT(*) AS n FROM browser_cookies WHERE project_id = 'prj_b' AND name = 'zombie'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("never crosses profiles (rows are per project_id, _default included)", () => {
    const database = freshDb();
    const jarA = new CookieJar(database, "prj_alpha");
    feed(jarA, "a=1", "https://a.example/");
    jarA.persist();
    const jarDefault = new CookieJar(database, "_default");
    feed(jarDefault, "d=1", "https://a.example/");
    jarDefault.persist();

    expect(loadBrowserCookies(database, "prj_alpha").map((c) => c.name)).toEqual(["a"]);
    expect(loadBrowserCookies(database, "_default").map((c) => c.name)).toEqual(["d"]);
    expect(loadBrowserCookies(database, "prj_omega")).toEqual([]);

    // replaceBrowserCookies only rewrites ITS profile's rows.
    replaceBrowserCookies(database, "prj_omega", [
      {
        projectId: "prj_omega",
        name: "o",
        domain: "a.example",
        path: "/",
        value: "9",
        expiresAt: null,
        hostOnly: true,
        secure: false,
        httpOnly: false,
        storedAt: new Date().toISOString(),
      },
    ]);
    expect(loadBrowserCookies(database, "prj_alpha")).toHaveLength(1);
    expect(loadBrowserCookies(database, "_default")).toHaveLength(1);
    expect(loadBrowserCookies(database, "prj_omega")).toHaveLength(1);
  });
});
