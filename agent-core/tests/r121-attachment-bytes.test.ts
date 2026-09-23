/**
 * ROUND-121 (R121-a): GET /projects/:id/attachments/bytes — the pixels
 * round's server half. The R67 law ("no byte field rides the wire — bytes
 * go straight to the upload route, never into the event log") gets its
 * other half: bytes come BACK out through their own door, fetched on
 * demand by the display surfaces (the PC transcript's thumbnails, the
 * phone's UserImageThumb).
 *
 * Pinned here:
 *  - the happy path: a persisted image answers RAW BYTES with the right
 *    content-type, content-length, private cache headers (the dedupe law
 *    makes a path's bytes content-stable → caching is honest), and an ETag;
 *  - extension allowlist: png/jpg/jpeg/gif/webp/bmp pass (case-insensitive
 *    on the extension), anything else — including SVG and extension-less —
 *    is refused with the honest display-only message;
 *  - containment: ../ escapes and absolute paths are refused (400) by the
 *    same resolveInsideRoot resolver the read route rides;
 *  - the 8MB cap (the upload cap's mirror) and the directory refusal;
 *  - unknown project → 404; missing 'path' query → 400; a missing file
 *    under the project root → 404 (not 500 — readFileSync's throw maps to
 *    the honest not-found);
 *  - the round-trip with the UPLOAD route: upload dataBase64 → the
 *    returned project-relative path → the SAME bytes come back out.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r121";
const KEY = "sk-or-vtest-r121";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r121-bytes-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

async function makeProject(rootPath?: string): Promise<string> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "PixelsProject", rootPath: rootPath ?? tempDir },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

/** A tiny valid PNG (1×1, transparent) — real magic bytes, not zeros. */
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d49444154789c626001000000050001fa2cdc4d0000000049454e44ae426082",
  "hex",
);

function writeAttachment(projectRoot: string, name: string, bytes: Buffer): void {
  const dir = join(projectRoot, "attachments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

const bytesUrl = (projectId: string, path: string): string =>
  `/api/v1/projects/${projectId}/attachments/bytes?path=${encodeURIComponent(path)}`;

// ── the happy path ──────────────────────────────────────────────────────────

describe("GET /api/v1/projects/:id/attachments/bytes (ROUND-121 R121-a)", () => {
  it("a persisted PNG answers RAW BYTES with content-type, length, private cache headers, and an ETag", async () => {
    const projectId = await makeProject();
    writeAttachment(tempDir, "photo.png", TINY_PNG);

    const res = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/photo.png") });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(TINY_PNG.length));
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(String(res.headers["etag"])).toMatch(/^W\/"att-\d+-png"$/);
    // rawPayload is the exact bytes (no JSON envelope, no base64).
    expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
  });

  it("the extension is case-insensitive — photo.PNG answers image/png", async () => {
    const projectId = await makeProject();
    writeAttachment(tempDir, "photo.PNG", TINY_PNG);

    const res = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/photo.PNG") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("jpg/jpeg/gif/webp/bmp all pass with their MIME; svg and extension-less are refused", async () => {
    const projectId = await makeProject();
    for (const [name, mime] of [
      ["a.jpg", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.gif", "image/gif"],
      ["d.webp", "image/webp"],
      ["e.bmp", "image/bmp"],
    ] as const) {
      writeAttachment(tempDir, name, Buffer.from("x"));
      const ok = await authInject({ method: "GET", url: bytesUrl(projectId, `attachments/${name}`) });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["content-type"]).toBe(mime);
    }

    writeAttachment(tempDir, "vector.svg", Buffer.from("<svg/>"));
    const svg = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/vector.svg") });
    expect(svg.statusCode).toBe(400);
    expect(svg.json().error.message).toContain("not a displayable image");

    writeAttachment(tempDir, "README", Buffer.from("text"));
    const none = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/README") });
    expect(none.statusCode).toBe(400);
  });

  // ── containment (the read route's resolver, the same law) ──────────────

  it("a ../ escape is refused — the path must stay inside the project root", async () => {
    const projectId = await makeProject();
    const res = await authInject({
      method: "GET",
      url: bytesUrl(projectId, "attachments/../../secret.png"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("escapes the project root");
  });

  it("an absolute path is refused — only project-RELATIVE paths resolve", async () => {
    const projectId = await makeProject();
    const res = await authInject({
      method: "GET",
      url: bytesUrl(projectId, "/etc/hostname"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("RELATIVE");
  });

  // ── the honest refusals ────────────────────────────────────────────────

  it("a file above the 8MB cap is refused", async () => {
    const projectId = await makeProject();
    // 8MB + 1 of a fake "png" — the cap check fires before any read.
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
    writeAttachment(tempDir, "big.png", big);

    const res = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/big.png") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("8MB image limit");
  });

  it("a directory with an image-y name is refused, not read", async () => {
    const projectId = await makeProject();
    mkdirSync(join(tempDir, "attachments", "folder.png"), { recursive: true });

    const res = await authInject({ method: "GET", url: bytesUrl(projectId, "attachments/folder.png") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("directory");
  });

  it("an unknown project answers 404; a missing file under a known project answers 404", async () => {
    const missingProject = await authInject({
      method: "GET",
      url: bytesUrl("proj_does-not-exist", "attachments/x.png"),
    });
    expect(missingProject.statusCode).toBe(404);

    const projectId = await makeProject();
    const missingFile = await authInject({
      method: "GET",
      url: bytesUrl(projectId, "attachments/never-uploaded.png"),
    });
    expect(missingFile.statusCode).toBe(404);
    expect(missingFile.json().error.message).toContain("no attachment at");
  });

  it("a missing 'path' query parameter answers 400", async () => {
    const projectId = await makeProject();
    const res = await authInject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/attachments/bytes`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("path");
  });

  // ── the round-trip with the upload route (the R67 pipeline closed) ─────

  it("upload dataBase64 → the returned project-relative path → the SAME bytes come back out", async () => {
    const projectId = await makeProject();

    const up = await authInject({
      method: "POST",
      url: "/api/v1/attachments/upload",
      payload: { projectId, name: "sent.png", dataBase64: TINY_PNG.toString("base64") },
    });
    expect(up.statusCode).toBe(200);
    const { path } = up.json() as { path: string };

    const res = await authInject({ method: "GET", url: bytesUrl(projectId, path) });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
  });
});
