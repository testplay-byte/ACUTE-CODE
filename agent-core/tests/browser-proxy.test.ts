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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  })) as LightMyRequestResponse;
}

/** Header-less request — what an iframe navigation actually looks like. */
async function iframeGet(url: string): Promise<LightMyRequestResponse> {
  return (await app.inject({ method: "GET", url })) as LightMyRequestResponse;
}

async function mintTicket(sessionId = SESSION): Promise<string> {
  const res = await inject({ method: "POST", url: "/api/v1/browser/session", payload: { sessionId } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ticket: string }).ticket;
}

function proxyUrl(target: string, ticket: string, sessionId = SESSION): string {
  return `/api/v1/browser/proxy?${new URLSearchParams({ url: target, sessionId, bt: ticket }).toString()}`;
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
    // Links/assets are re-proxied with the ticket echoed in.
    expect(body).toContain(proxyUrl(`${upstreamBase}/about.html`, ticket));
    expect(body).toContain(proxyUrl("https://external.example/x?y=1", ticket));
    expect(body).toContain(proxyUrl(`${upstreamBase}/style.css`, ticket));
    expect(body).toContain(proxyUrl(`${upstreamBase}/favicon.ico`, ticket));
    expect(body).toContain(proxyUrl(`${upstreamBase}/app.js`, ticket));
    expect(body).toContain(proxyUrl(`${upstreamBase}/pic.png`, ticket));
    expect(body).toContain(proxyUrl("https://nested.example/embed", ticket));
    expect(body).toContain(`action="${proxyUrl(`${upstreamBase}/search`, ticket)}`);
    // Inline style url() + action-less forms (action injected = current page).
    expect(body).toContain(`url('${proxyUrl(`${upstreamBase}/bg.png`, ticket)}')`);
    expect(body).toContain(`<form method="get" action="${proxyUrl(`${upstreamBase}/page.html`, ticket)}">`);
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
  });

  it("absolute-izes relative URLs against nested page paths (page dir, ../, root)", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/deep/guide/index.html`, ticket));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(proxyUrl(`${upstreamBase}/deep/guide/styles.css`, ticket));
    expect(res.body).toContain(proxyUrl(`${upstreamBase}/deep/img/logo.png`, ticket));
    expect(res.body).toContain(proxyUrl(`${upstreamBase}/root.js`, ticket));
  });

  it("rewrites every srcset candidate but leaves data: candidates inline", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl(`${upstreamBase}/page.html`, ticket));
    expect(res.body).toContain(`srcset="${proxyUrl(`${upstreamBase}/a.png`, ticket)} 1x`);
    expect(res.body).toContain(`${proxyUrl(`${upstreamBase}/b.png`, ticket)} 2x`);
    expect(res.body).toContain(`${proxyUrl("https://cdn.example.com/c.png", ticket)} 3x`);
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
    expect(res.body).toContain(`url(${proxyUrl(`${upstreamBase}/bg.png`, ticket)})`);
    expect(res.body).toContain(`url('${proxyUrl(`${upstreamBase}/font.woff2`, ticket)}')`);
    expect(res.body).toContain(`@import "${proxyUrl(`${upstreamBase}/more.css`, ticket)}"`);
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
  it("refuses non-http schemes with an HTML 403 page (file://)", async () => {
    const ticket = await mintTicket();
    const res = await iframeGet(proxyUrl("file:///etc/passwd", ticket));
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("refused scheme 'file:'");
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
    expect(firstBody.viewport.width).toBe(1280);

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

  it("rejects bad bodies (no url/direction, bad direction, non-http url, bad sessionId)", async () => {
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, direction: "sideways" } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: SESSION, url: "file:///x" } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/v1/browser/navigate", payload: { sessionId: "bad id!", url: A } })).statusCode).toBe(400);
    expect((await inject({ method: "GET", url: "/api/v1/browser/history?sessionId=bad id!" })).statusCode).toBe(400);
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
    expect(initial.viewport).toEqual({ width: 1280, height: 800, preset: "laptop", zoom: 1, rotate: false });

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
    expect(other.viewport.width).toBe(1280);
  });
});
