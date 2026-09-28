// @vitest-environment node
/**
 * ROUND-131 (R131-F, Wave F1): the WORKSPACE SCAFFOLD — the owner's
 * directive: "whenever the user selects a folder… all the necessary files
 * and folders for it should be created… it will create a hidden folder or
 * our own folder where it will store its own things… so that the actual
 * folder does not get affected by it and the user's actual projects are
 * handled properly."
 *
 * Pins in this file (storage/workspace.ts + its two call sites + the
 * Files-tree containment law):
 *   1. THE MODULE — ensureProjectWorkspace's two paths: FRESH (no marker →
 *      .acute/{downloads,tools,memory,tmp} + the workspace.json marker,
 *      created:true) and RESUME (marker present → heal missing subfolders,
 *      healed:true, the marker NEVER rewritten — createdAt preserved).
 *      Idempotence, the never-touch-any-other-file law, and the honest
 *      THROW contract (vanished root / root-is-a-file / .acute-is-a-file /
 *      a corrupt marker still heals without rewriting).
 *   2. POST /projects — the scaffold rides project creation; the happy
 *      path's response stays byte-identical (no workspaceWarning field),
 *      and a scaffold FAILURE degrades honestly: 201 + workspaceWarning +
 *      the project row still exists and still serves.
 *   3. THE BOOT HEAL — ensureGeneralProject heals the Scratchpad root's
 *      scaffold every boot (fresh, idempotent, degraded, and the VANISHED
 *      root case — the ledger's missing-cwd ENOENT cure for legacy
 *      installs).
 *   4. THE FILES-TREE LAW — `.acute/` never appears in projectTree (the
 *      fs-ops dot-dir hide, re-pinned against the new folder) while
 *      list_dir still reaches it (hidden from the explorer, NOT from
 *      tools) — and list_dir's R131-F header names the directory it
 *      listed.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import {
  ensureProjectWorkspace,
  readWorkspaceMarker,
  workspaceMarkerPath,
  workspaceSubfolderPath,
  WORKSPACE_DIR_NAME,
  WORKSPACE_MARKER_VERSION,
  WORKSPACE_SUBFOLDERS,
} from "../src/storage/workspace";
import { ensureGeneralProject } from "../src/storage/general-project";
import { projectTree, listDir } from "../src/tools/index";

const TOKEN = "test-token-r131workspace";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r131-workspace-"));
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

/** A fresh empty folder per scenario. */
function freshRoot(): string {
  return mkdtempSync(join(tempDir, `root-${randomUUID().slice(0, 8)}-`));
}

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

// ── 1. The module: ensureProjectWorkspace ────────────────────────────────────

describe("R131-F F1: ensureProjectWorkspace — the FRESH path", () => {
  it("creates .acute + all four subfolders + the marker; created:true, healed:false", () => {
    const root = freshRoot();
    const result = ensureProjectWorkspace(root);

    expect(result.created).toBe(true);
    expect(result.healed).toBe(false);
    expect(result.subfolders).toEqual(
      WORKSPACE_SUBFOLDERS.map((name) => join(root, WORKSPACE_DIR_NAME, name)),
    );
    for (const name of WORKSPACE_SUBFOLDERS) {
      expect(statSync(join(root, WORKSPACE_DIR_NAME, name)).isDirectory()).toBe(true);
    }
    // The marker: version 1, an ISO createdAt, the app's version string.
    const marker = readWorkspaceMarker(root);
    expect(marker).not.toBeNull();
    expect(marker?.version).toBe(WORKSPACE_MARKER_VERSION);
    expect(marker?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof marker?.appVersion).toBe("string");
    expect((marker?.appVersion ?? "").length).toBeGreaterThan(0);
  });

  it("is IDEMPOTENT — a second call creates/heals nothing and never rewrites the marker", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    const markerBefore = readFileSync(workspaceMarkerPath(root), "utf8");

    const second = ensureProjectWorkspace(root);

    expect(second.created).toBe(false);
    expect(second.healed).toBe(false);
    // Byte-identical marker — createdAt and appVersion survive every call.
    expect(readFileSync(workspaceMarkerPath(root), "utf8")).toBe(markerBefore);
  });

  it("NEVER touches any other file in the root — only .acute appears", () => {
    const root = freshRoot();
    writeFileSync(join(root, "user-notes.md"), "the user's own file\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export {};\n");

    ensureProjectWorkspace(root);

    // The user's files are byte-identical and the root gained ONLY .acute.
    expect(readFileSync(join(root, "user-notes.md"), "utf8")).toBe("the user's own file\n");
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("export {};\n");
    expect(readdirSync(root).sort()).toEqual([WORKSPACE_DIR_NAME, "src", "user-notes.md"].sort());
    // And .acute holds exactly the four subfolders + the marker.
    expect(readdirSync(join(root, WORKSPACE_DIR_NAME)).sort()).toEqual(
      [...WORKSPACE_SUBFOLDERS, "workspace.json"].sort(),
    );
  });
});

describe("R131-F F1: ensureProjectWorkspace — the RESUME path (previously-used folder)", () => {
  it("heals a MISSING subfolder (marker present): healed:true, marker untouched, createdAt preserved", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    const createdAtBefore = readWorkspaceMarker(root)?.createdAt;
    // The user (or an older version) lost tmp:
    rmSync(workspaceSubfolderPath(root, "tmp"), { recursive: true, force: true });

    const result = ensureProjectWorkspace(root);

    expect(result.created).toBe(false);
    expect(result.healed).toBe(true);
    expect(statSync(workspaceSubfolderPath(root, "tmp")).isDirectory()).toBe(true);
    // The marker was NEVER rewritten — the workspace's history survives.
    expect(readWorkspaceMarker(root)?.createdAt).toBe(createdAtBefore);
  });

  it("heals MULTIPLE missing subfolders (the upgrade-era shape: a .acute with only skills/)", () => {
    // The pre-R131 world: consumers made their own .acute subfolders on
    // demand — an old project can carry .acute/skills/ and nothing else.
    const root = freshRoot();
    mkdirSync(join(root, WORKSPACE_DIR_NAME, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, WORKSPACE_DIR_NAME, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
    writeFileSync(workspaceMarkerPath(root), `${JSON.stringify({ version: 1, createdAt: "2026-09-01T00:00:00.000Z", appVersion: "0.122.0" }, null, 2)}\n`);

    const result = ensureProjectWorkspace(root);

    expect(result.created).toBe(false);
    expect(result.healed).toBe(true);
    for (const name of WORKSPACE_SUBFOLDERS) {
      expect(statSync(join(root, WORKSPACE_DIR_NAME, name)).isDirectory()).toBe(true);
    }
    // The pre-existing content is untouched + the marker keeps its history.
    expect(readFileSync(join(root, WORKSPACE_DIR_NAME, "skills", "demo", "SKILL.md"), "utf8")).toContain("name: demo");
    expect(readWorkspaceMarker(root)?.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(readWorkspaceMarker(root)?.appVersion).toBe("0.122.0");
  });

  it("a whole-but-healthy workspace: created:false, healed:false, nothing changes", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    const markerBefore = readFileSync(workspaceMarkerPath(root), "utf8");

    const again = ensureProjectWorkspace(root);
    expect(again).toEqual({ created: false, healed: false, subfolders: again.subfolders });
    expect(readFileSync(workspaceMarkerPath(root), "utf8")).toBe(markerBefore);
  });

  it("a CORRUPT marker still heals the subfolders — and is never rewritten (the file stays as-is)", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    rmSync(workspaceSubfolderPath(root, "memory"), { recursive: true, force: true });
    const corrupt = "{not json at all";
    writeFileSync(workspaceMarkerPath(root), corrupt);

    const result = ensureProjectWorkspace(root);

    expect(result.created).toBe(false);
    expect(result.healed).toBe(true);
    expect(statSync(workspaceSubfolderPath(root, "memory")).isDirectory()).toBe(true);
    // The unreadable marker is KEPT verbatim — a corrupt file is still the
    // "previously used" signal, and overwriting what we cannot parse would
    // be destroying history we do not own.
    expect(readFileSync(workspaceMarkerPath(root), "utf8")).toBe(corrupt);
    expect(readWorkspaceMarker(root)).toBeNull();
  });
});

describe("R131-F F1: ensureProjectWorkspace — the honest THROW contract", () => {
  it("a vanished root throws naming the DIRECTORY (never an exe-naming ENOENT)", () => {
    const vanished = join(tempDir, `vanished-${randomUUID().slice(0, 8)}`);
    expect(existsSync(vanished)).toBe(false);
    expect(() => ensureProjectWorkspace(vanished)).toThrow(/does not exist/);
    expect(() => ensureProjectWorkspace(vanished)).toThrow(vanished);
  });

  it("a root that exists but is a FILE throws its own honest spelling", () => {
    const fileRoot = join(tempDir, `not-a-dir-${randomUUID().slice(0, 8)}`);
    writeFileSync(fileRoot, "a file, not a folder");
    expect(() => ensureProjectWorkspace(fileRoot)).toThrow(/is not a directory/);
    expect(() => ensureProjectWorkspace(fileRoot)).toThrow(fileRoot);
  });

  it("a `.acute` that exists as a FILE fails honestly (naming the path + the code)", () => {
    const root = freshRoot();
    writeFileSync(join(root, WORKSPACE_DIR_NAME), "a file squatting on the drawer's name");
    expect(() => ensureProjectWorkspace(root)).toThrow(/cannot scaffold the workspace/);
    expect(() => ensureProjectWorkspace(root)).toThrow(join(root, WORKSPACE_DIR_NAME));
  });
});

// ── 2. POST /projects wiring ─────────────────────────────────────────────────

describe("R131-F F1: POST /projects scaffolds the workspace (degrade-honestly)", () => {
  it("a fresh folder: 201, NO workspaceWarning field (the happy path is byte-identical), the scaffold on disk", async () => {
    const root = freshRoot();
    const created = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Scaffolded", rootPath: root },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as Record<string, unknown>;
    expect(body.name).toBe("Scaffolded");
    // The warning field is ABSENT on success — the additive-only law.
    expect(body.workspaceWarning).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["color", "createdAt", "id", "name", "rootPath"].sort());
    // The scaffold happened:
    expect(readWorkspaceMarker(root)?.version).toBe(WORKSPACE_MARKER_VERSION);
    for (const name of WORKSPACE_SUBFOLDERS) {
      expect(statSync(join(root, WORKSPACE_DIR_NAME, name)).isDirectory()).toBe(true);
    }
  });

  it("a PREVIOUSLY-USED folder heals through the route too (marker present + tmp missing)", async () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    rmSync(workspaceSubfolderPath(root, "tmp"), { recursive: true, force: true });
    const createdAt = readWorkspaceMarker(root)?.createdAt;

    const created = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Resumed", rootPath: root },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as Record<string, unknown>).workspaceWarning).toBeUndefined();
    expect(statSync(workspaceSubfolderPath(root, "tmp")).isDirectory()).toBe(true);
    expect(readWorkspaceMarker(root)?.createdAt).toBe(createdAt);
  });

  it("a scaffold FAILURE is a WARNING, not a failed create: 201 + workspaceWarning + the project row lives", async () => {
    const root = freshRoot();
    // The deterministic failure: `.acute` squatted by a file → mkdir ENOTDIR.
    writeFileSync(join(root, WORKSPACE_DIR_NAME), "not a directory");

    const created = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Warned", rootPath: root },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as Record<string, unknown>;
    expect(typeof body.workspaceWarning).toBe("string");
    expect(body.workspaceWarning).toContain("cannot scaffold the workspace");
    expect(body.workspaceWarning).toContain(join(root, WORKSPACE_DIR_NAME));

    // The project STILL works — the row exists and serves:
    const id = body.id as string;
    const fetched = await authInject({ method: "GET", url: `/api/v1/projects/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as Record<string, unknown>).rootPath).toBe(root);
  });
});

// ── 3. The boot heal (ensureGeneralProject) ──────────────────────────────────

describe("R131-F F1: the boot heal — ensureGeneralProject heals the Scratchpad root's scaffold", () => {
  it("a boot seeds the Scratchpad root's workspace (marker + the four subfolders)", () => {
    const dataDir = freshRoot();
    ensureGeneralProject(db, dataDir);
    const scratchRoot = join(dataDir, "scratchpad");
    expect(readWorkspaceMarker(scratchRoot)?.version).toBe(WORKSPACE_MARKER_VERSION);
    for (const name of WORKSPACE_SUBFOLDERS) {
      expect(statSync(join(scratchRoot, WORKSPACE_DIR_NAME, name)).isDirectory()).toBe(true);
    }
  });

  it("idempotent across boots: the marker's createdAt survives every heal", () => {
    const dataDir = freshRoot();
    ensureGeneralProject(db, dataDir);
    const scratchRoot = join(dataDir, "scratchpad");
    const createdAt = readWorkspaceMarker(scratchRoot)?.createdAt;
    ensureGeneralProject(db, dataDir);
    ensureGeneralProject(db, dataDir);
    expect(readWorkspaceMarker(scratchRoot)?.createdAt).toBe(createdAt);
  });

  it("a DEGRADED Scratchpad root (user-deleted tmp) is healed on the next boot", () => {
    const dataDir = freshRoot();
    ensureGeneralProject(db, dataDir);
    const scratchRoot = join(dataDir, "scratchpad");
    rmSync(workspaceSubfolderPath(scratchRoot, "tmp"), { recursive: true, force: true });

    ensureGeneralProject(db, dataDir);

    expect(statSync(workspaceSubfolderPath(scratchRoot, "tmp")).isDirectory()).toBe(true);
  });

  it("the legacy-install cure: a VANISHED Scratchpad root is recreated (mkdir) and scaffolded (heal)", () => {
    const dataDir = freshRoot();
    ensureGeneralProject(db, dataDir);
    const scratchRoot = join(dataDir, "scratchpad");
    // The whole root vanishes (the ledger's missing-cwd ENOENT shape):
    rmSync(scratchRoot, { recursive: true, force: true });
    expect(existsSync(scratchRoot)).toBe(false);

    ensureGeneralProject(db, dataDir);

    // The root exists again, WITH the scaffold — the ENOENT root cause is
    // healed at boot, not discovered mid-command.
    expect(statSync(scratchRoot).isDirectory()).toBe(true);
    expect(readWorkspaceMarker(scratchRoot)?.version).toBe(WORKSPACE_MARKER_VERSION);
    for (const name of WORKSPACE_SUBFOLDERS) {
      expect(statSync(join(scratchRoot, WORKSPACE_DIR_NAME, name)).isDirectory()).toBe(true);
    }
  });
});

// ── 4. The Files-tree law (dot-dir hide) + list_dir reach ────────────────────

describe("R131-F F1: the Files tree hides .acute — while tools still reach it", () => {
  it("projectTree NEVER lists .acute (the dot-dir law, re-pinned against the new folder)", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);
    mkdirSync(join(root, "visible-src"), { recursive: true });
    writeFileSync(join(root, "visible-src", "a.ts"), "export {};\n");

    const names: string[] = [];
    const walk = (nodes: Array<{ name: string; children?: unknown[] }>): void => {
      for (const node of nodes) {
        names.push(node.name);
        if (Array.isArray(node.children)) walk(node.children as typeof nodes);
      }
    };
    walk(projectTree(root));

    expect(names).not.toContain(WORKSPACE_DIR_NAME);
    expect(names).not.toContain("downloads");
    expect(names).not.toContain("workspace.json");
    expect(names).toContain("visible-src");
    expect(names).toContain("a.ts");
  });

  it("list_dir still REACHES .acute (hidden from the explorer, not from tools) — and its header names the directory", () => {
    const root = freshRoot();
    ensureProjectWorkspace(root);

    const listing = listDir(root, WORKSPACE_DIR_NAME);
    expect(listing.ok).toBe(true);
    // The R131-F header names the resolved directory + the TRUE entry
    // count (the four subfolders + the marker file itself):
    expect(listing.output.startsWith(`listed ${join(root, WORKSPACE_DIR_NAME)} — ${WORKSPACE_SUBFOLDERS.length + 1} entries\n`)).toBe(true);
    for (const name of WORKSPACE_SUBFOLDERS) {
      // The pre-existing line grammar ("dir " + " " + name — a double
      // space, kept verbatim by the R131-F header change):
      expect(listing.output).toContain(`dir  ${name}/`);
    }
    // The marker file is listed too (the drawer's own inventory):
    expect(listing.output).toContain("file workspace.json");
  });

  it("the empty-directory leg now NAMES the directory it found empty", () => {
    const root = freshRoot();
    mkdirSync(join(root, "empty-one"));

    const listing = listDir(root, "empty-one");
    expect(listing.ok).toBe(true);
    expect(listing.output).toBe(`listed ${join(root, "empty-one")} — 0 entries\n(empty directory)`);
  });
});
