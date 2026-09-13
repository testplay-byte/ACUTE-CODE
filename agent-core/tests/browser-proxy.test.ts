/**
 * ROUND-43 (R43-10) — embedded-browser proxy backend tests.
 *
 * Upstream is a REAL local node:http server (mock pages/CSS/binary/ranges/
 * redirects/echo), hermetically on 127.0.0.1:<ephemeral> and let through the
 * private-net guard via the module's test hook (the shipped allowlist covers
 * only the app's own vite :5173). Covers: HTML/CSS rewriting, srcset, binary
 * + Range passthrough, scheme/private-net guards (including redirect hops),
 * size cap, upstream error pages, POST form passthrough, header hygiene
 * (no cookie/authz forwarding, framing blockers stripped), ticket auth for
 * header-less iframe loads, history semantics, viewport validation, and
 * sessionId validation.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import {
  extendPrivateNetAllowlistForTest,
  resetPrivateNetAllowlistForTest,
} from "../src/browser-proxy";

const TOKEN = "test-token-r43-browser";
const SESSION = "tab-one";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;
let upstream: http.Server;
let upstreamBase = "";

// ── mock upstream (pages, css, binary, ranges, redirects, echo) ────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const PAGE_HTML = (base: string): string =>
  `<!doctype html><html><head>` +
  `<meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">` +
  `<base href="http://old.example/old">` +
  `<title>Upstream page</title>` +
  `<link rel="stylesheet" href="style.css">` +
  `<link rel="icon" href="/favicon.ico">` +
  `</head><body>` +
  `<a href="about.html">About</a>` +
  `<a href="https://external.example/x?y=1">Ext</a>` +
  `<a href="javascript:alert(1)">JS</a>` +
  `<a href="/api/v1/browser/proxy?url=https%3A%2F%2Fkeep.example%2Fx&sessionId=tab-one&bt=deadbeef">Keep</a>` +
  `<script>var s = '<img src="http://trap.example/x.png">';</script>` +
  `<script src="/app.js"></script>` +
  `<img src="pic.png" srcset="a.png 1x, b.png 2x, https://cdn.example.com/c.png 3x">` +
  `<source src="clip.mp4" srcset="v1.webm 1x, data:image/gif;base64,R0lGODlh,AAAA 2x">` +
  `<iframe src="https://nested.example/embed"></iframe>` +
  `<form action="/search" method="post"><input name="q"></form>` +
  `<form method="get"><input name="id"></form>` +
  `<div style="background: url('bg.png')">hi</div>` +
  `</body></html>` +
  `<!-- base=${base} -->`;

const DEEP_HTML =
  `<!doctype html><html><head><title>Deep</title></head><body>` +
  `<a href="styles.css">rel</a><img src="../img/logo.png"><script src="/root.js"></script>` +
  `</body></html>`;

const STYLE_CSS =
  `body { background: url(bg.png); } ` +
  `@font-face { src: url('font.woff2') format('woff2'); } ` +
  `@import "more.css"; ` +
  `.safe { background: url(data:image/gif;base64,R0lGODlh); }`;

const upstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? "/", upstreamBase);
  const send = (status: number, headers: Record<string, string>, body: string | Buffer): void => {
    res.writeHead(status, headers);
    res.end(body);
  };
  switch (url.pathname) {
    case "/page.html":
      send(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
        "strict-transport-security": "max-age=31536000",
        "cross-origin-opener-policy": "same-origin",
      }, PAGE_HTML(upstreamBase));
      return;
    case "/deep/guide/index.html":
      send(200, { "content-type": "text/html" }, DEEP_HTML);
      return;
    case "/style.css":
      send(200, { "content-type": "text/css; charset=utf-8" }, STYLE_CSS);
      return;
    case "/img.png": {
      const range = req.headers.range;
      if (typeof range === "string") {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (match !== null) {
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), PNG_BYTES.length - 1);
          const slice = PNG_BYTES.subarray(start, end + 1);
          send(206, {
            "content-type": "image/png",
            "content-range": `bytes ${start}-${end}/${PNG_BYTES.length}`,
            "accept-ranges": "bytes",
          }, slice);
          return;
        }
      }
      send(200, { "content-type": "image/png", "accept-ranges": "bytes" }, PNG_BYTES);
      return;
    }
    case "/redirect":
      send(302, { location: "/page.html", "content-type": "text/plain" }, "");
      return;
    // ROUND-46 (R46-d) cookie-jar fixtures.
    case "/set-cookie":
      send(200, { "content-type": "text/plain", "set-cookie": "victim=sess123; Path=/" }, "ok");
      return;
    case "/set-cookie-many": {
      const many: string[] = [];
      for (let i = 1; i <= 205; i += 1) {
        many.push(`c${String(i).padStart(3, "0")}=${i}; Path=/`);
      }
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": many });
      res.end("ok");
      return;
    }
    case "/login-redirect":
      // A login-style hop: the cookie rides the 302, the NEXT hop must
      // already carry it.
      send(302, { location: "/echo", "content-type": "text/plain", "set-cookie": "hop=1; Path=/" }, "");
      return;
    case "/redirect-lan":
      // Redirects into the LAN must be refused per hop — never connected.
      send(302, { location: "http://127.0.0.1:9/private", "content-type": "text/plain" }, "");
      return;
    case "/big":
      // Declared size over the 25 MiB cap → refused before the body is read.
      send(200, { "content-type": "application/octet-stream", "content-length": String(26 * 1024 * 1024 + 1) }, "x");
      return;
    case "/missing":
      send(404, { "content-type": "text/plain" }, "not found");
      return;
    case "/boom":
      send(500, { "content-type": "text/plain" }, "kaboom");
      return;
    case "/echo": {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const received: Record<string, unknown> = {
          method: req.method,
          body,
          contentType: req.headers["content-type"] ?? null,
          cookie: req.headers.cookie ?? null,
          authorization: req.headers.authorization ?? null,
        };
        // Guard against accidental credential forwarding in rewrites/tests.
        void res.writeHead(200, { "content-type": "application/json", "set-cookie": "leak=1; Path=/" });
        res.end(JSON.stringify(received));
      });
      return;
    }
    default:
      send(404, { "content-type": "text/plain" }, `unknown mock path ${url.pathname}`);
  }
};

// ── harness ────────────────────────────────────────────────────────────────

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r43browser-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    upstream = http.createServer(upstreamHandler);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  const port = String((upstream.address() as AddressInfo).port);
  upstreamBase = `http://127.0.0.1:${port}`;
  extendPrivateNetAllowlistForTest(`127.0.0.1:${port}`);
  extendPrivateNetAllowlistForTest(`localhost:${port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  resetPrivateNetAllowlistForTest();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows file-handle lag)
  }
});


async function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    // ROUND-49: a deterministic Host pins the sidecar origin the rewriter
    // stamps into sub-resource URLs (see rewrittenProxyUrl below).
    headers: { authorization: `Bearer ${TOKEN}`, host: SIDECAR_HOST, ...(options.headers ?? {}) },
  })) as LightMyRequestResponse;
}

/** Header-less request — what an iframe navigation actually looks like.
 * The Host header is NOT auth: real iframe navigations always carry it, and
 * the rewriter needs it to stamp absolute sub-resource URLs. */
async function iframeGet(url: string): Promise<LightMyRequestResponse> {
  return (await app.inject({ method: "GET", url, headers: { host: SIDECAR_HOST } })) as LightMyRequestResponse;
}

async function mintTicket(sessionId = SESSION): Promise<string> {
  const res = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ticket: string }).ticket;
}

function proxyUrl(target: string, ticket: string, sessionId = SESSION): string {
  return `/api/v1/browser/proxy?${new URLSearchParams({ url: target, sessionId, bt: ticket }).toString()}`;
}

/**
 * ROUND-49: the origin rewritten sub-resource URLs must carry. rewriteHtml
 * injects <base href="UPSTREAM"> into the document, so a path-relative
 * rewrite (`/api/v1/browser/proxy?…`) resolves against the UPSTREAM origin —
 * every CSS/JS/img request 404'd on the upstream site and pages rendered as
 * unstyled HTML (the owner's round-48 report). Rewrites are now ABSOLUTE
 * against the sidecar origin derived from the request's Host header.
 */
const SIDECAR_HOST = "sidecar.local:5178";
const SIDECAR_ORIGIN = `http://${SIDECAR_HOST}`;
function rewrittenProxyUrl(target: string, ticket: string, sessionId = SESSION): string {
  return `${SIDECAR_ORIGIN}/api/v1/browser/proxy?${new URLSearchParams({ url: target, sessionId, bt: ticket }).toString()}`;
}

// ── HTML rewriting (the heart) ─────────────────────────────────────────────

describe("GET /browser/proxy — HTML rewrite", () => {
  it("injects our base, rewrites href/src/img/iframe/form URLs, strips framing headers, keeps script bodies, and appends the escape hatch", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    // Framing blockers never survive the proxy.
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();

    const body = res.body;
    // Our base replaces the page's own.
    expect(body).toContain(`<base href="${upstreamBase}/page.html">`);
    expect(body).not.toContain("old.example");
    // In-document CSP meta is stripped.
    expect(body).not.toContain("Content-Security-Policy");
    // Links/assets are re-proxied with the ticket echoed in — ABSOLUTE
    // URLs (ROUND-49: rewrites must survive the injected <base href=upstream>).
    expect(body).toContain(rewrittenProxyUrl(`${upstreamBase}/about.html`, ticket));
    expect(body).toContain(rewrittenProxyUrl("https://external.example/x?y=1", ticket));
    expect(body).toContain(rewrittenProxyUrl(`${upstreamBase}/style.css`, ticket));
    expect(body).toContain(rewrittenProxyUrl(`${upstreamBase}/favicon.ico`, ticket));
    expect(body).toContain(rewrittenProxyUrl(`${upstreamBase}/app.js`, ticket));
    expect(body).toContain(rewrittenProxyUrl(`${upstreamBase}/pic.png`, ticket));
    expect(body).toContain(rewrittenProxyUrl("https://nested.example/embed", ticket));
    expect(body).toContain(`action="${rewrittenProxyUrl(`${upstreamBase}/search`, ticket)}`);
    // Inline style url() + action-less forms (action injected = current page).
    expect(body).toContain(`url('${rewrittenProxyUrl(`${upstreamBase}/bg.png`, ticket)}')`);
    expect(body).toContain(`<form method="get" action="${rewrittenProxyUrl(`${upstreamBase}/page.html`, ticket)}">`);
    // javascript: href neutralized; already-proxied URL untouched.
    expect(body).toContain(`<a href="#">JS</a>`);
    expect(body).toContain(
      `/api/v1/browser/proxy?url=https%3A%2F%2Fkeep.example%2Fx&sessionId=tab-one&bt=deadbeef`,
    );
    // Script BODY is protected from the tag pass (the JS-string trap stays raw).
    expect(body).toContain(`var s = '<img src="http://trap.example/x.png">';`);
    // Escape hatch: open interception + title/location reporting.
    expect(body).toContain("window.open=");
    expect(body).toContain(`{type:"acute:title"`);
    expect(body).toContain(`{type:"acute:open"`);
    expect(body).toContain(`{type:"acute:location",url:"${upstreamBase}/page.html"}`);
    // injected before </body>.
    expect(body.indexOf("window.__ACUTE_BROWSER__")).toBeGreaterThan(-1);
    expect(body.indexOf("__ACUTE_BROWSER__")).toBeLessThan(body.toLowerCase().lastIndexOf("</body>"));
    // ROUND-49 (THE bug this round): no path-relative REWRITES remain. A
    // relative /api/v1/browser/proxy?... inside a document whose
    // <base href> points at the UPSTREAM origin resolves against that origin
    // — every CSS/JS/img sub-resource 404'd upstream and pages rendered as
    // unstyled HTML (owner round-48 report). All rewrites must be ABSOLUTE
    // against the sidecar origin (SIDECAR_ORIGIN assertions above). The ONLY
    // relative proxy URL left is a value that was ALREADY a proxy path in
    // the source (the Keep link — a pass-through, not a rewrite).
    const relativeProxyUrls = [...body.matchAll(/(?:href|src|action)="(\/api\/v1\/browser\/proxy\?[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(relativeProxyUrls).toEqual([
      `/api/v1/browser/proxy?url=${encodeURIComponent("https://keep.example/x")}&sessionId=tab-one&bt=deadbeef`,
    ]);
    expect(body).not.toContain(`url('/api/v1/browser/proxy?`);
    expect(body).not.toContain(`url(/api/v1/browser/proxy?`);
    expect(body).not.toContain(`url(/api/v1/browser/proxy?`);
  });

  it("ROUND-49: sub-resource errors return an EMPTY body with the upstream status (no HTML error page parsed as CSS/JS)", async () => {
    const ticket = await mintTicket();
    // A stylesheet fetch (sec-fetch-dest: style) for a MISSING upstream file
    // (the mock's default 404).
    const css = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/missing.css`, ticket),
      headers: { host: SIDECAR_HOST, "sec-fetch-dest": "style" },
    });
    expect(css.statusCode).toBe(404);
    expect(css.body).toBe("");
    // A script fetch (sec-fetch-dest: script) for a 500 upstream.
    const js = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/boom`, ticket),
      headers: { host: SIDECAR_HOST, "sec-fetch-dest": "script" },
    });
    expect(js.statusCode).toBe(500);
    expect(js.body).toBe("");
    // A NAVIGATION (sec-fetch-dest: iframe — what the panel's own iframe
    // sends) still gets the friendly HTML error card.
    const nav = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/missing`, ticket),
      headers: { host: SIDECAR_HOST, "sec-fetch-dest": "iframe", accept: "text/html,application/xhtml+xml" },
    });
    expect(nav.statusCode).toBe(404);
    expect(nav.body).toContain("Unable to load page");
  });

  it("absolute-izes relative URLs against nested page paths (page dir, ../, root)", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/deep/guide/index.html`, ticket));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(rewrittenProxyUrl(`${upstreamBase}/deep/guide/styles.css`, ticket));
    expect(res.body).toContain(rewrittenProxyUrl(`${upstreamBase}/deep/img/logo.png`, ticket));
    expect(res.body).toContain(rewrittenProxyUrl(`${upstreamBase}/root.js`, ticket));
  });

  it("rewrites every srcset candidate but leaves data: candidates inline", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(res.body).toContain(`srcset="${rewrittenProxyUrl(`${upstreamBase}/a.png`, ticket)} 1x`);
    expect(res.body).toContain(`${rewrittenProxyUrl(`${upstreamBase}/b.png`, ticket)} 2x`);
    expect(res.body).toContain(`${rewrittenProxyUrl("https://cdn.example.com/c.png", ticket)} 3x`);
    // data: URL survives (comma re-merge keeps the base64 payload attached).
    expect(res.body).toContain("data:image/gif;base64,R0lGODlh");
  });

  it("follows redirects, rewrites against the FINAL url, and reports it", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/redirect`, ticket));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-acute-final-url"]).toBe(`${upstreamBase}/page.html`);
    expect(res.body).toContain(`<base href="${upstreamBase}/page.html">`);
  });
});

// ── CSS + binary passthrough ───────────────────────────────────────────────

describe("GET /browser/proxy — CSS and binary", () => {
  it("rewrites url() and @import inside stylesheets", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/style.css`, ticket));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.body).toContain(`url(${rewrittenProxyUrl(`${upstreamBase}/bg.png`, ticket)})`);
    expect(res.body).toContain(`url('${rewrittenProxyUrl(`${upstreamBase}/font.woff2`, ticket)}')`);
    expect(res.body).toContain(`@import "${rewrittenProxyUrl(`${upstreamBase}/more.css`, ticket)}"`);
    expect(res.body).toContain("url(data:image/gif;base64,R0lGODlh)");
  });

  it("passes binary bodies through untouched with the original content-type", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/img.png`, ticket));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(res.rawPayload).equals(PNG_BYTES)).toBe(true);
  });

  it("passes Range requests through (206 + content-range + slice)", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/img.png`, ticket));
    expect(res.statusCode).toBe(200); // sanity: full body first
    const ranged = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/img.png`, ticket),
      headers: { authorization: `Bearer ${TOKEN}`, range: "bytes=0-3" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-3/${PNG_BYTES.length}`);
    expect(Buffer.from(ranged.rawPayload).equals(PNG_BYTES.subarray(0, 4))).toBe(true);
  });
});

// ── guards + failure pages ─────────────────────────────────────────────────

describe("GET /browser/proxy — guards and error pages", () => {
  it("refuses non-http schemes with an HTML 403 page (file://) that points at the local-file route", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl("file:///etc/passwd", ticket));
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("refused scheme 'file:'");
    // R95-C: the message steers file navigations to the native browser /
    // local-file route instead of a dead end.
    expect(res.body).toContain("local-file");
    expect(res.body).toContain("file:///etc/passwd");
  });

  it("refuses private-network targets — but the allowlisted dev server passes", async () => {
    const ticket = await mintTicket();
    const blocked = await iframeGet(proxyUrl("http://127.0.0.1:9999/secret", ticket));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toContain("private-network");
    expect(blocked.body).toContain("127.0.0.1:9999");

    const allowed = await iframeGet(proxyUrl(`${upstreamBase.replace("127.0.0.1", "localhost")}/page.html`, ticket));
    expect(allowed.statusCode).toBe(200);
  });

  it("refuses a redirect whose NEXT hop is private (per-hop guard)", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/redirect-lan`, ticket));
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("private-network");
  });

  it("returns an HTML error page when the declared body exceeds the size cap", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/big`, ticket));
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("proxy cap");
    expect(res.body).toContain(`${upstreamBase}/big`);
  });

  it("renders upstream 404/500 as our HTML error page with the upstream status", async () => {
    const ticket = await mintTicket();
    const notFound = await iframeGet(proxyUrl(`${upstreamBase}/missing`, ticket));
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers["content-type"]).toContain("text/html");
    expect(notFound.body).toContain("upstream returned HTTP 404");

    const boom = await iframeGet(proxyUrl(`${upstreamBase}/boom`, ticket));
    expect(boom.statusCode).toBe(500);
    expect(boom.body).toContain("upstream returned HTTP 500");
  });

  it("rejects an invalid sessionId with the 400 HTML page (no URL injection)", async () => {
    const res = await app.inject({
      method: "GET",
      // No bt — header-authed call with a malformed sessionId.
      url: `/api/v1/browser/proxy?url=${encodeURIComponent(`${upstreamBase}/page.html`)}&sessionId=../evil`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("sessionId");
  });
});

// ── POST passthrough + header hygiene ──────────────────────────────────────

describe("POST /browser/proxy — form passthrough and hygiene", () => {
  it("forwards urlencoded POST method, content-type and body upstream", async () => {
    const ticket = await mintTicket();
    const res = await app.inject({
      method: "POST",
      url: proxyUrl(`${upstreamBase}/echo`, ticket),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "q=acute&go=1",
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json() as { method: string; body: string; contentType: string | null };
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("q=acute&go=1");
    expect(echoed.contentType).toContain("application/x-www-form-urlencoded");
  });

  it("never forwards our credentials (authorization/cookie) upstream, nor set-cookie downstream", async () => {
    const ticket = await mintTicket();
    const res = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/echo`, ticket),
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "sid=supersecret" },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json() as { cookie: string | null; authorization: string | null };
    expect(echoed.cookie).toBeNull();
    expect(echoed.authorization).toBeNull();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

// ── ticket auth (the iframe's way in) ──────────────────────────────────────

describe("browser session tickets", () => {
  it("mints a 48-hex ticket bound to the session and rotates on re-mint (old ticket dies)", async () => {
    const first = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId: SESSION } });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { ticket: string; expiresAt: number; history: { entries: unknown[] }; viewport: { width: number } };
    expect(firstBody.ticket).toMatch(/^[a-f0-9]{48}$/);
    expect(firstBody.expiresAt).toBeGreaterThan(Date.now());
    expect(firstBody.history.entries).toEqual([]);
    expect(firstBody.viewport.width).toBe(1440);

    const second = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId: SESSION } });
    const secondTicket = (second.json() as { ticket: string }).ticket;
    expect(secondTicket).not.toBe(firstBody.ticket);

    const old = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, firstBody.ticket));
    expect(old.statusCode).toBe(401);
    const fresh = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, secondTicket));
    expect(fresh.statusCode).toBe(200);
  });

  it("serves a header-less iframe load with a valid bt, and HTML-401s garbage/missing tickets", async () => {
    const ticket = await mintTicket();
    const ok = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(ok.statusCode).toBe(200);

    const garbage = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, "0".repeat(48)));
    expect(garbage.statusCode).toBe(401);
    expect(garbage.headers["content-type"]).toContain("text/html");
    expect(garbage.body).toContain("ticket");

    const bare = await app.inject({ method: "GET", url: `/api/v1/browser/proxy?url=${encodeURIComponent(`${upstreamBase}/page.html`)}&sessionId=${SESSION}` });
    expect(bare.statusCode).toBe(401);
    expect(bare.headers["content-type"]).toContain("text/html");
  });

  it("rejects a bt whose sessionId does not match (403)", async () => {
    const ticket = await mintTicket(SESSION);
    const res = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket, "other-tab"));
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("does not match");
  });

  it("header-authed calls without bt auto-adopt the session so rewrites still carry a ticket", async () => {
    const res = await inject({
      method: "GET",
      url: `/api/v1/browser/proxy?url=${encodeURIComponent(`${upstreamBase}/page.html`)}&sessionId=${SESSION}`,
    });
    expect(res.statusCode).toBe(200);
    const ticketMatch = /bt=([a-f0-9]{48})/.exec(res.body);
    expect(ticketMatch).not.toBeNull();
    // The auto-minted ticket actually works for a header-less iframe load.
    const reload = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticketMatch?.[1] as string));
    expect(reload.statusCode).toBe(200);
  });

  it("DELETE /browser/session drops the session and its ticket", async () => {
    const ticket = await mintTicket();
    const gone = await inject({ method: "DELETE", url: `/api/v1/browser/session?sessionId=${SESSION}` });
    expect(gone.statusCode).toBe(200);
    const after = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(after.statusCode).toBe(401);
    const missing = await inject({ method: "DELETE", url: `/api/v1/browser/session?sessionId=${SESSION}` });
    expect(missing.statusCode).toBe(404);
  });
});

// ── ROUND-48 (R48-d): implicit session touches must NOT rotate the ticket ─

// The owner's flash-loop bug: POST /browser/navigate and PUT /browser/viewport
// used to re-mint the session ticket on every call while their responses
// carry NO ticket — so the panel's iframe kept a dead `bt` → HTML 401 page →
// panel recovery re-mint → go("reload") → rotate again → 0.9-2s flash loop.
// Ticket rotation now happens ONLY in POST /browser/session (whose response
// carries the new ticket and the panel adopts it).
describe("ROUND-48 (R48-d): navigate/viewport never rotate the ticket", () => {
  it("POST /browser/navigate keeps the pre-navigate ticket alive (mint → navigate → proxy with the ORIGINAL bt → 200)", async () => {
    const ticket = await mintTicket();
    const nav = await inject({
      method: "POST",
      url: "/api/v1/browser/navigate",
      payload: { sessionId: SESSION, url: `${upstreamBase}/page.html` },
    });
    expect(nav.statusCode).toBe(200);
    expect((nav.json() as { action: string }).action).toBe("push");

    // The iframe holding the pre-navigate ticket still loads the page —
    // this exact request was the 401 that started every flash cycle.
    const page = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(page.statusCode).toBe(200);
    // The rewrites inside that page echo the SAME, still-valid ticket.
    expect(page.body).toContain(`bt=${ticket}`);
  });

  it("navigate back/forward/reload and title-update are equally non-rotating", async () => {
    const ticket = await mintTicket();
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: "https://a.example/" } });
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: `${upstreamBase}/page.html` } });
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "back" } });
    const titled = await inject({
      method: "POST",
      url: "/api/v1/browser/navigate",
      payload: { sessionId: SESSION, url: "https://a.example/", title: "A" },
    });
    expect((titled.json() as { action: string }).action).toBe("title-update");
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "forward" } });
    // "reload" is the panel recovery's own call — rotating HERE re-killed
    // every freshly minted ticket (the loop's engine).
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "reload" } });

    const page = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(page.statusCode).toBe(200);
  });

  it("PUT /browser/viewport keeps the current ticket alive (mint → viewport → proxy with the ORIGINAL bt → 200)", async () => {
    const ticket = await mintTicket();
    const vp = await inject({
      method: "PUT",
      url: "/api/v1/browser/viewport",
      payload: { sessionId: SESSION, preset: "mobile-sm" },
    });
    expect(vp.statusCode).toBe(200);
    expect((vp.json() as { viewport: { width: number } }).viewport.width).toBe(375);

    // Resolution/size changes land mid-load — in-flight subresources (and
    // the next iframe src) must keep authorizing with the same ticket.
    const page = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(page.statusCode).toBe(200);
  });

  it("header-authed proxy adoption keeps the session's existing ticket (no rotation, rewrites reuse it)", async () => {
    const ticket = await mintTicket();
    const res = await inject({
      method: "GET",
      url: `/api/v1/browser/proxy?url=${encodeURIComponent(`${upstreamBase}/page.html`)}&sessionId=${SESSION}`,
    });
    expect(res.statusCode).toBe(200);
    // The adopted page carries the ticket the session ALREADY had (create()
    // here used to mint a new one nobody told the panel about)…
    expect(res.body).toContain(`bt=${ticket}`);
    // …and that original ticket still authorizes a header-less iframe load.
    const reload = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(reload.statusCode).toBe(200);
  });

  it("ticket TTL still refreshes on use and an idle ticket still expires after 12h", async () => {
    // Only Date is faked — the upstream fetch keeps its real sockets.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ticket = await mintTicket();
      // Used tickets keep living: 11h idle → use → 11h idle → use → 200 each
      // time (every touch re-arms the full 12h TTL).
      vi.advanceTimersByTime(11 * 60 * 60 * 1000);
      expect((await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket))).statusCode).toBe(200);
      vi.advanceTimersByTime(11 * 60 * 60 * 1000);
      expect((await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket))).statusCode).toBe(200);
      // An UNUSED ticket dies after 12h — the honest 401 page the panel's
      // (now capped) recovery path exists for.
      vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 60_000);
      const dead = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
      expect(dead.statusCode).toBe(401);
      expect(dead.body).toContain("ticket");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── ROUND-46 (R46-d): the cookie jar ─────────────────────────────────────

describe("browser proxy cookie jar (ROUND-46)", () => {
  it("stores upstream Set-Cookie values and replays them on the next request", async () => {
    const ticket = await mintTicket();
    const first = await iframeGet(proxyUrl(`${upstreamBase}/set-cookie`, ticket));
    expect(first.statusCode).toBe(200);

    const res = await iframeGet(proxyUrl(`${upstreamBase}/echo`, ticket));
    expect(res.statusCode).toBe(200);
    const echoed = res.json() as { cookie: string | null };
    expect(echoed.cookie).toBe("victim=sess123");
  });

  it("never lets a CLIENT Cookie header smuggle or override — the jar is the only source", async () => {
    const ticket = await mintTicket();
    await iframeGet(proxyUrl(`${upstreamBase}/set-cookie`, ticket));
    // The client (a page inside the sandboxed iframe) tries to smuggle a
    // foreign cookie AND override the jar's value — upstream must see ONLY
    // the jar's cookie.
    const res = await app.inject({
      method: "GET",
      url: proxyUrl(`${upstreamBase}/echo`, ticket),
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "evil=smuggled; victim=hacked" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cookie: string | null }).cookie).toBe("victim=sess123");
  });

  it("cookies survive a simulated sidecar restart (fresh server, SAME database)", async () => {
    const ticket = await mintTicket();
    await iframeGet(proxyUrl(`${upstreamBase}/set-cookie`, ticket));

    // A brand-new server on the same DB = a sidecar restart: the session
    // store is empty (new mint needed) but the cookie jar lazily restores.
    const app2 = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });
    try {
      const mint = await app2.inject({
        method: "POST",
        url: "/api/v1/browser/session",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { sessionId: SESSION },
      });
      expect(mint.statusCode).toBe(200);
      const res = await app2.inject({
        method: "GET",
        url: proxyUrl(
          `${upstreamBase}/echo`,
          (mint.json() as { ticket: string }).ticket,
        ),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { cookie: string | null }).cookie).toBe("victim=sess123");
    } finally {
      await app2.close();
    }
  });

  it("DELETE /browser/session keeps the jar (closing a tab is not logging out)", async () => {
    const ticket = await mintTicket();
    await iframeGet(proxyUrl(`${upstreamBase}/set-cookie`, ticket));
    const gone = await inject({ method: "DELETE", url: `/api/v1/browser/session?sessionId=${SESSION}` });
    expect(gone.statusCode).toBe(200);

    const reMint = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId: SESSION } });
    const res = await iframeGet(
      proxyUrl(`${upstreamBase}/echo`, (reMint.json() as { ticket: string }).ticket),
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cookie: string | null }).cookie).toBe("victim=sess123");
  });

  it("ingests Set-Cookie on EVERY redirect hop and replays it on the final hop", async () => {
    const ticket = await mintTicket();
    // /login-redirect 302s to /echo WITH a Set-Cookie — the cookie set by
    // the FIRST hop must already ride the SECOND hop's request.
    const res = await iframeGet(proxyUrl(`${upstreamBase}/login-redirect`, ticket));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cookie: string | null }).cookie).toBe("hop=1");
  });

  it("scopes jars per cookie profile (body.projectId at mint; _default apart)", async () => {
    const mintP1 = await inject({
      method: "POST",
      url: "/api/v1/browser/session",
      payload: { sessionId: "tab-p1", projectId: "prj_one" },
    });
    expect(mintP1.statusCode).toBe(200);
    const t1 = (mintP1.json() as { ticket: string }).ticket;
    await iframeGet(proxyUrl(`${upstreamBase}/set-cookie`, t1, "tab-p1"));

    // A different profile sees nothing.
    const mintP2 = await inject({
      method: "POST",
      url: "/api/v1/browser/session",
      payload: { sessionId: "tab-p2", projectId: "prj_two" },
    });
    const t2 = (mintP2.json() as { ticket: string }).ticket;
    const other = await iframeGet(proxyUrl(`${upstreamBase}/echo`, t2, "tab-p2"));
    expect((other.json() as { cookie: string | null }).cookie).toBeNull();

    // The shared _default profile is its own jar too.
    const mintDefault = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId: "tab-d" } });
    const tDefault = (mintDefault.json() as { ticket: string }).ticket;
    const def = await iframeGet(proxyUrl(`${upstreamBase}/echo`, tDefault, "tab-d"));
    expect((def.json() as { cookie: string | null }).cookie).toBeNull();

    // The bound profile still replays its cookie.
    const again = await iframeGet(proxyUrl(`${upstreamBase}/echo`, t1, "tab-p1"));
    expect((again.json() as { cookie: string | null }).cookie).toBe("victim=sess123");

    // Malformed profile ids are rejected like malformed session ids.
    const bad = await inject({
      method: "POST",
      url: "/api/v1/browser/session",
      payload: { sessionId: "tab-x", projectId: "../evil" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("caps the jar at 200 cookies per profile (oldest evicted, persisted capped)", async () => {
    const ticket = await mintTicket();
    const many = await iframeGet(proxyUrl(`${upstreamBase}/set-cookie-many`, ticket));
    expect(many.statusCode).toBe(200);

    const res = await iframeGet(proxyUrl(`${upstreamBase}/echo`, ticket));
    const header = (res.json() as { cookie: string | null }).cookie ?? "";
    const names = header.split("; ").map((pair) => pair.split("=")[0]);
    expect(names).toHaveLength(200);
    expect(names).not.toContain("c001"); // the five OLDEST were evicted
    expect(names).not.toContain("c005");
    expect(names).toContain("c006");
    expect(names).toContain("c205");

    // The durable rows are capped the same way after the full-replace save.
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM browser_cookies WHERE project_id = '_default'")
      .get() as { n: number };
    expect(n).toBe(200);
  });
});

// ── history semantics ──────────────────────────────────────────────────────

describe("POST /browser/navigate + GET /browser/history", () => {
  const A = "https://a.example/";
  const B = "https://b.example/docs";
  const C = "https://c.example/";
  const D = "https://d.example/";

  it("pushes, walks back/forward, truncates the forward tail, reloads, and updates titles", async () => {
    const pushA = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: A } })).json() as { action: string; index: number; canBack: boolean };
    expect(pushA).toMatchObject({ action: "push", index: 0, canBack: false });
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: B } });
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: C } });

    const back = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "back" } })).json() as { action: string; entry: { url: string }; index: number; canBack: boolean; canForward: boolean };
    expect(back.action).toBe("back");
    expect(back.entry.url).toBe(B);
    expect(back).toMatchObject({ index: 1, canBack: true, canForward: true });

    const forward = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "forward" } })).json() as { action: string; entry: { url: string } };
    expect(forward.action).toBe("forward");
    expect(forward.entry.url).toBe(C);

    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "back" } });
    const branch = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: D } })).json() as { action: string; index: number; canForward: boolean };
    expect(branch.action).toBe("push");
    expect(branch.canForward).toBe(false); // C dropped from the tail

    const noMoreForward = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "forward" } })).json() as { action: string };
    expect(noMoreForward.action).toBe("noop");

    const reload = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "reload" } })).json() as { action: string; entry: { url: string } };
    expect(reload.action).toBe("reload");
    expect(reload.entry.url).toBe(D);

    const titled = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: D, title: "Doc" } })).json() as { action: string; entry: { url: string; title: string } };
    expect(titled.action).toBe("title-update");
    expect(titled.entry.title).toBe("Doc");

    const history = (await inject({ method: "GET", url: `/api/v1/browser/history?sessionId=${SESSION}` })).json() as { entries: Array<{ url: string; title: string | null }>; index: number; canBack: boolean; canForward: boolean };
    expect(history.entries.map((e) => e.url)).toEqual([A, B, D]);
    expect(history.entries[2].title).toBe("Doc");
    expect(history).toMatchObject({ index: 2, canBack: true, canForward: false });
  });

  it("caps history at 50 entries (oldest fall off)", async () => {
    for (let i = 0; i < 55; i += 1) {
      await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: `https://h.example/${i}` } });
    }
    const history = (await inject({ method: "GET", url: `/api/v1/browser/history?sessionId=${SESSION}` })).json() as { entries: Array<{ url: string }>; index: number };
    expect(history.entries).toHaveLength(50);
    expect(history.entries[0].url).toBe("https://h.example/5");
    expect(history.index).toBe(49);
  });

  it("rejects bad bodies (no url/direction, bad direction, non-http(s)/file url, bad sessionId)", async () => {
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "sideways" } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: "about:blank" } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: "bad id!", url: A } })).statusCode).toBe(400);
    expect((await inject({ method: "GET", url: "/api/v1/browser/history?sessionId=bad id!" })).statusCode).toBe(400);
  });

  it("R95-C: navigate accepts file:// URLs as first-class history entries", async () => {
    const push = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: "file:///C:/Users/me/page.html" } })).json() as { action: string; entry: { url: string } };
    expect(push.action).toBe("push");
    expect(push.entry.url).toBe("file:///C:/Users/me/page.html");
    // Back/forward walk them like any other entry.
    await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: A } });
    const back = (await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "back" } })).json() as { entry: { url: string } };
    expect(back.entry.url).toBe("file:///C:/Users/me/page.html");
  });

  it("GET history for an unknown session returns an empty view (no side effects)", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/browser/history?sessionId=fresh-tab" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: "fresh-tab", entries: [], index: -1, canBack: false, canForward: false });
  });
});

// ── viewport (display-size state for panel + future agent tool) ────────────

describe("GET/PUT /browser/viewport", () => {
  it("returns defaults for unknown sessions and validates bounds/preset/zoom", async () => {
    const initial = (await inject({ method: "GET", url: `/api/v1/browser/viewport?sessionId=${SESSION}` })).json() as { viewport: { width: number; height: number; preset: string; zoom: number; rotate: boolean } };
    expect(initial.viewport).toEqual({ width: 1440, height: 900, preset: "desktop", zoom: 1, rotate: false });

    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, width: 150 } })).statusCode).toBe(400);
    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, width: 5000 } })).statusCode).toBe(400);
    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, height: 100 } })).statusCode).toBe(400);
    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, zoom: 5 } })).statusCode).toBe(400);
    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, preset: "cinema" } })).statusCode).toBe(400);
    expect((await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: "bad id!" } })).statusCode).toBe(400);
  });

  it("applies preset dimensions, stores custom sizes, and persists per session", async () => {
    const tablet = (await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, preset: "tablet" } })).json() as { viewport: { width: number; height: number; preset: string } };
    expect(tablet.viewport).toMatchObject({ width: 768, height: 1024, preset: "tablet" });

    const custom = (await inject({ method: "PUT", url: "/api/v1/browser/viewport", payload: { sessionId: SESSION, width: 480, height: 320, zoom: 1.5, rotate: true } })).json() as { viewport: { preset: string; zoom: number; rotate: boolean } };
    expect(custom.viewport).toMatchObject({ preset: "custom", zoom: 1.5, rotate: true });

    const readBack = (await inject({ method: "GET", url: `/api/v1/browser/viewport?sessionId=${SESSION}` })).json() as { viewport: { width: number; height: number } };
    expect(readBack.viewport).toMatchObject({ width: 480, height: 320 });

    // Sessions are isolated.
    const other = (await inject({ method: "GET", url: "/api/v1/browser/viewport?sessionId=tab-two" })).json() as { viewport: { width: number } };
    expect(other.viewport.width).toBe(1440);
  });
});

// ── ROUND-95 (R95-C): the local-file route (file:// pages in web dev mode) ─

describe("GET /browser/local-file (R95-C)", () => {
  /** Per-test fixture dir (the shared tempDir is cleaned once, after all). */
  let files = "";
  beforeEach(() => {
    files = join(tempDir, `local-files-${randomUUID()}`);
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, "page.html"), "<!doctype html><html><body><h1>Local page</h1></body></html>");
    writeFileSync(join(files, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`);
    writeFileSync(join(files, "notes.txt"), "plain notes");
    writeFileSync(join(files, "app.exe"), Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  });

  const localFileUrl = (path: string, ticket: string, sessionId = SESSION): string =>
    `/api/v1/browser/local-file?${new URLSearchParams({ path, sessionId, bt: ticket }).toString()}`;

  it("serves an .html file to a header-less iframe load with a valid ticket", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(localFileUrl(join(files, "page.html"), ticket));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("<h1>Local page</h1>");
  });

  it("serves svg and text files with their content types", async () => {
    const ticket = await mintTicket();
    const svg = await iframeGet(localFileUrl(join(files, "icon.svg"), ticket));
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.body).toContain("<rect/>");

    const txt = await iframeGet(localFileUrl(join(files, "notes.txt"), ticket));
    expect(txt.statusCode).toBe(200);
    expect(txt.headers["content-type"]).toContain("text/plain");
    expect(txt.body).toContain("plain notes");
  });

  it("refuses missing files (404), directories (400) and relative paths (400) with the HTML error card", async () => {
    const ticket = await mintTicket();

    const missing = await iframeGet(localFileUrl(join(files, "nope.html"), ticket));
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("text/html");
    expect(missing.body).toContain("does not exist");

    const dir = await iframeGet(localFileUrl(files, ticket));
    expect(dir.statusCode).toBe(400);
    expect(dir.body).toContain("is not a file");

    const relative = await iframeGet(localFileUrl("demo.html", ticket));
    expect(relative.statusCode).toBe(400);
    expect(relative.body).toContain("path must be absolute");
  });

  it("refuses non-renderable extensions (an .exe is not a page) with the honest 415", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(localFileUrl(join(files, "app.exe"), ticket));
    expect(res.statusCode).toBe(415);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("application/octet-stream");
    expect(res.body).toContain("browser panel renders HTML, SVG, text and image files");
  });

  it("refuses files over the 10 MiB cap (413)", async () => {
    const big = join(files, "big.html");
    const chunk = "<!-- " + "x".repeat(1024 * 1024) + " -->\n"; // 1 MiB-ish lines
    const handle = [];
    for (let i = 0; i < 11; i++) handle.push(chunk);
    writeFileSync(big, handle.join(""));
    const ticket = await mintTicket();
    const res = await iframeGet(localFileUrl(big, ticket));
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("local-file cap");
  });

  it("ticket-gates like the proxy: garbage bt → HTML 401; mismatched sessionId → 403", async () => {
    const ticket = await mintTicket();
    // A valid ticket goes through; the header-less garbage one gets the 401 card.
    const ok = await iframeGet(localFileUrl(join(files, "page.html"), ticket));
    expect(ok.statusCode).toBe(200);
    const garbage = await app.inject({
      method: "GET",
      url: localFileUrl(join(files, "page.html"), "0".repeat(48)),
      headers: { host: SIDECAR_HOST },
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.headers["content-type"]).toContain("text/html");
    expect(garbage.body).toContain("ticket");

    const mismatch = await iframeGet(localFileUrl(join(files, "page.html"), ticket, "other-tab"));
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.body).toContain("does not match");
  });

  it("refuses non-navigation requests (sec-fetch-dest empty = a page fetch()ing other local files)", async () => {
    const ticket = await mintTicket();
    const res = await app.inject({
      method: "GET",
      url: localFileUrl(join(files, "page.html"), ticket),
      headers: { host: SIDECAR_HOST, "sec-fetch-dest": "empty" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("serves browser navigations only");
    // The same request shaped like the iframe's own load passes.
    const nav = await app.inject({
      method: "GET",
      url: localFileUrl(join(files, "page.html"), ticket),
      headers: { host: SIDECAR_HOST, "sec-fetch-dest": "iframe" },
    });
    expect(nav.statusCode).toBe(200);
  });

  it("POST answers like GET (a static file has no server-side handler — the page just reloads)", async () => {
    const ticket = await mintTicket();
    // A form inside a local page posts urlencoded to its own URL.
    const res = await app.inject({
      method: "POST",
      url: localFileUrl(join(files, "page.html"), ticket),
      headers: { host: SIDECAR_HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: "q=1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>Local page</h1>");
  });
});
