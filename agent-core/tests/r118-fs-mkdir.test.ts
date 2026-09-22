/**
 * r118-fs-mkdir.test.ts — POST /api/v1/system/fs/mkdir (R118-E §2D): the
 * browse route's WRITE twin, so a NEW folder can become a project the
 * moment it exists (before this round POST /projects statSync-validated
 * the root and 404'd on a fresh folder — a brand-new directory genuinely
 * could not be registered).
 *
 * The route's honest contract, pinned end-to-end through buildServer +
 * inject() (the r114-sync-wave / server.test.ts harness):
 *   · 201 {path, name, dir: true}   — the browse entry's shape verbatim;
 *                                      ONE level, recursive:false — the
 *                                      route never materializes a missing
 *                                      parent chain.
 *   · 400 VALIDATION (field-named)  — a relative parentPath, a parent that
 *                                      is not a directory, or a name the
 *                                      phone's folderNameValid would have
 *                                      refused ("" · >60 · separators ·
 *                                      "."/".." · leading dot · control).
 *   · 404 NOT_FOUND                  — a missing parent (the browse route's
 *                                      ENOENT spelling, message riding).
 *   · 409 CONFLICT                   — EEXIST: the folder is already there.
 *
 * Trust model (R114-b, unchanged): a paired phone has config rights —
 * /system/fs/mkdir is NOT on the device-token blocklist by construction
 * (no blocklist change ships with this route). The blocklist itself is
 * pinned by the r109 tests; this file pins the route's own behavior.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r118mkdir";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r118mkdir-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** POST the mkdir route with a typed body. */
async function mkdir(
  parentPath: unknown,
  name: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/system/fs/mkdir",
    payload: { parentPath, name },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** The error body's {code, message, details} shape the route answers with. */
function errOf(body: Record<string, unknown>): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  const error = body.error as { code: string; message: string; details?: Record<string, unknown> };
  return { code: error.code, message: error.message, details: error.details ?? {} };
}

// ── the happy path ───────────────────────────────────────────────────────────

describe("R118-E: POST /system/fs/mkdir — 201", () => {
  it("creates ONE directory under the parent and answers the browse entry's shape verbatim", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    const { status, body } = await mkdir(parent, "new-project");
    expect(status).toBe(201);
    expect(body).toEqual({ path: join(parent, "new-project"), name: "new-project", dir: true });

    // The directory REALLY exists (the whole point: POST /projects' statSync
    // gate accepts it the moment it lands).
    expect(statSync(join(parent, "new-project")).isDirectory()).toBe(true);
  });

  it("trims the name before creating — '  spaced  ' creates 'spaced' and answers it", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    const { status, body } = await mkdir(parent, "  spaced  ");
    expect(status).toBe(201);
    expect(body).toEqual({ path: join(parent, "spaced"), name: "spaced", dir: true });
    expect(statSync(join(parent, "spaced")).isDirectory()).toBe(true);
  });

  it("never climbs: a separator-free name cannot join above the parent (recursive:false, one level only)", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    // A nested chain is NOT materialized — the name rules refuse separators
    // outright (the 400 table below), and a single name is exactly one level.
    const { status } = await mkdir(parent, "leaf");
    expect(status).toBe(201);
    expect(statSync(join(parent, "leaf")).isDirectory()).toBe(true);
    expect(statSync(parent).isDirectory()).toBe(true);
  });

  it("the created folder appears in the browse listing immediately (the write twin of the read route)", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    for (const name of ["zeta", "alpha"]) mkdirSync(join(parent, name));
    writeFileSync(join(parent, "readme.md"), "x");

    const { status } = await mkdir(parent, "mid-folder");
    expect(status).toBe(201);

    const response = await authInject({
      method: "GET",
      url: `/api/v1/system/fs/browse?path=${encodeURIComponent(parent)}`,
    });
    expect(response.statusCode).toBe(200);
    const names = (
      (response.json() as { entries: Array<{ name: string }> }).entries.map((e) => e.name)
    );
    // Dirs-first, alphabetical within the group — the new folder rides the
    // route's own order, exactly where the optimistic client insert put it.
    expect(names).toEqual(["alpha", "mid-folder", "zeta", "readme.md"]);
  });
});

// ── 409 CONFLICT ─────────────────────────────────────────────────────────────

describe("R118-E: POST /system/fs/mkdir — 409 EEXIST", () => {
  it("an already-present folder answers 409 CONFLICT (the phone renders 'a folder with that name already exists')", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    mkdirSync(join(parent, "taken"));
    const { status, body } = await mkdir(parent, "taken");
    expect(status).toBe(409);
    const err = errOf(body);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("already exists");
  });
});

// ── 404 NOT_FOUND ────────────────────────────────────────────────────────────

describe("R118-E: POST /system/fs/mkdir — 404 the missing parent", () => {
  it("a parent that does not exist answers 404 with the OS's own ENOENT message (the browse route's spelling)", async () => {
    const missing = join(tempDir, "no-such-parent");
    const { status, body } = await mkdir(missing, "child");
    expect(status).toBe(404);
    const err = errOf(body);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("no-such-parent");
    expect(err.message).toContain("ENOENT");
  });
});

// ── 400 VALIDATION — the parent ─────────────────────────────────────────────

describe("R118-E: POST /system/fs/mkdir — 400 the parent rules", () => {
  it("a RELATIVE parentPath is refused (the route resolves nothing against cwd)", async () => {
    const { status, body } = await mkdir("relative/path", "child");
    expect(status).toBe(400);
    const err = errOf(body);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("absolute");
    expect(err.details.field).toBe("body.parentPath");
  });

  it("a MISSING / non-string parentPath is the same 400 (not a crash)", async () => {
    const absent = await mkdir(undefined, "child");
    expect(absent.status).toBe(400);
    expect(errOf(absent.body).details.field).toBe("body.parentPath");

    const numeric = await mkdir(42, "child");
    expect(numeric.status).toBe(400);
    expect(errOf(numeric.body).details.field).toBe("body.parentPath");
  });

  it("a parent that is a FILE is refused (not a directory)", async () => {
    const parent = mkdtempSync(join(tempDir, "parent-"));
    const file = join(parent, "readme.md");
    writeFileSync(file, "x");
    const { status, body } = await mkdir(file, "child");
    expect(status).toBe(400);
    const err = errOf(body);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("not a directory");
  });
});

// ── 400 VALIDATION — the name (the phone's folderNameValid, server-side) ────

describe("R118-E: POST /system/fs/mkdir — 400 the name rules (folderNameValid's wall)", () => {
  let parent = "";
  beforeEach(() => {
    parent = mkdtempSync(join(tempDir, "parent-"));
  });

  const TABLE: ReadonlyArray<{ label: string; name: unknown; message: string }> = [
    { label: "empty", name: "", message: "must be a folder name" },
    { label: "whitespace-only (blank after trim)", name: "   ", message: "must be a folder name" },
    { label: "over the 60-char cap", name: "a".repeat(61), message: "capped at 60 characters" },
    { label: "a forward slash", name: "a/b", message: "cannot contain separators" },
    { label: "a backslash", name: "a\\b", message: "cannot contain separators" },
    { label: "dot-only '.'", name: ".", message: "must be a real folder name" },
    { label: "dot-only '..'", name: "..", message: "must be a real folder name" },
    { label: "a leading dot (invisible in the picker)", name: ".env", message: "cannot start with a dot" },
    { label: "a control character", name: "bad\nname", message: "cannot contain control characters" },
    { label: "a non-string name", name: 42, message: "must be a folder name" },
  ];

  it.each(TABLE)("$label → 400 VALIDATION naming body.name", async ({ name, message }) => {
    const { status, body } = await mkdir(parent, name);
    expect(status).toBe(400);
    const err = errOf(body);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain(message);
    expect(err.details.field).toBe("body.name");
  });

  it("60 characters passes (the cap's own boundary — one under the refusal)", async () => {
    const { status, body } = await mkdir(parent, "a".repeat(60));
    expect(status).toBe(201);
    expect((body as { name: string }).name).toBe("a".repeat(60));
  });
});
