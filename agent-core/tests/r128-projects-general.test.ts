/**
 * ROUND-128 (R128-W3, SCREENS.md §2 laws #8 + #9) — the projects-sidebar
 * backend suite, RE-PINNED ROUND-129 (R129-S — the Scratchpad rename: the
 * same row, the same protection, the new name + root):
 *
 *   1. THE SCRATCHPAD SEED (law #9, R129-S): ensureGeneralProject seeds the
 *      app's internal workspace project (stable id "general", NAME
 *      "Scratchpad", root <dataDir>/scratchpad) — creating the folder,
 *      idempotently, re-pointing the row when the data dir moves, and
 *      MIGRATING a row still carrying the pre-R129 default name "General"
 *      (an owner-rename to anything else is respected); DELETE
 *      /projects/general is 409 general_protected and the row survives.
 *   2. THE DELETE CASCADE + EVENT (law #8's backend half): deleting a
 *      project removes its sessions AND every dependent row
 *      (session_events / usage_events / approvals / file_snapshots — plus
 *      the codebase_index FK cascade), returns the honest counts, and
 *      publishes the {type:"project", kind:"deleted"} events-bus frame.
 *      R129-S verified: deleteProject is RECORDS-ONLY (no fs import in
 *      storage/projects.ts — the files-on-disk-untouched half of law #8).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createProject } from "../src/storage/projects";
import {
  GENERAL_PROJECT_COLOR,
  GENERAL_PROJECT_ID,
  GENERAL_PROJECT_NAME,
  ensureGeneralProject,
} from "../src/storage/general-project";
import { appendSessionEvent, createSession, recordUsage } from "../src/storage/sessions";
import { recordSnapshot } from "../src/storage/snapshots";
import { createApproval } from "../src/approvals";
import { getEventsBus, type EventsBusFrame } from "../src/lib/events-bus";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>>;
const TOKEN = "test-token-r128w3";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r128-projects-"));
  dataDir = mkdtempSync(join(tmpdir(), "acute-r128-data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
});

afterEach(async () => {
  await app.close();
  db.close();
  for (const dir of [tempDir, dataDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows handle lag — best effort */
    }
  }
});

function authInject(options: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}) {
  return app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

describe("R129-S (SCREENS §2 law #9): the Scratchpad seed (the R128 General row, renamed)", () => {
  it("ensureGeneralProject creates the internal folder and the project row", () => {
    ensureGeneralProject(db, dataDir);

    // R129-S: the seed root is <dataDir>/scratchpad now (the legacy
    // <dataDir>/general dir is never CREATED nor deleted by the new seed).
    expect(existsSync(join(dataDir, "scratchpad"))).toBe(true);
    expect(existsSync(join(dataDir, "general"))).toBe(false);
    const rows = db
      .prepare("SELECT id, name, root_path, color FROM projects")
      .all() as { id: string; name: string; root_path: string; color: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: GENERAL_PROJECT_ID,
      name: GENERAL_PROJECT_NAME,
      root_path: join(dataDir, "scratchpad"),
      color: GENERAL_PROJECT_COLOR,
    });
  });

  it("is idempotent — a second boot neither duplicates the row nor recreates values", () => {
    ensureGeneralProject(db, dataDir);
    const first = db
      .prepare("SELECT id, name, root_path, color, created_at FROM projects WHERE id = ?")
      .get(GENERAL_PROJECT_ID) as { created_at: string };
    ensureGeneralProject(db, dataDir);
    ensureGeneralProject(db, dataDir);

    const rows = db.prepare("SELECT * FROM projects").all();
    expect(rows).toHaveLength(1);
    const second = rows[0] as { created_at: string };
    // The row is the SAME row — created_at untouched (INSERT OR IGNORE
    // semantics; a re-seed never resets the workspace's history).
    expect(second.created_at).toBe(first.created_at);
  });

  it("re-points root_path when the data dir moves, and leaves a healthy row alone", () => {
    ensureGeneralProject(db, dataDir);
    const movedDir = mkdtempSync(join(tmpdir(), "acute-r129-moved-"));
    try {
      ensureGeneralProject(db, movedDir);
      const row = db
        .prepare("SELECT root_path FROM projects WHERE id = ?")
        .get(GENERAL_PROJECT_ID) as { root_path: string };
      expect(row.root_path).toBe(join(movedDir, "scratchpad"));
      expect(existsSync(join(movedDir, "scratchpad"))).toBe(true);
    } finally {
      rmSync(movedDir, { recursive: true, force: true });
    }
  });

  // R129-S: the boot-time RENAME MIGRATION — a row still carrying the
  // pre-R129 default name "General" migrates to "Scratchpad" + the new
  // root in ONE write; an owner-rename to something else is respected
  // verbatim (only the untouched default migrates).
  it("migrates a pre-R129 default row: name → Scratchpad AND root → the scratchpad dir", () => {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, color, created_at)
       VALUES (?, 'General', ?, '#64748B', '2026-08-19T00:00:00Z')`,
    ).run(GENERAL_PROJECT_ID, join(dataDir, "general"));

    ensureGeneralProject(db, dataDir);

    const row = db
      .prepare("SELECT name, root_path FROM projects WHERE id = ?")
      .get(GENERAL_PROJECT_ID) as { name: string; root_path: string };
    expect(row.name).toBe("Scratchpad");
    expect(row.root_path).toBe(join(dataDir, "scratchpad"));
    // Idempotent: a second boot re-migrates nothing (the name check fails).
    ensureGeneralProject(db, dataDir);
    const again = db
      .prepare("SELECT name, root_path FROM projects WHERE id = ?")
      .get(GENERAL_PROJECT_ID) as { name: string; root_path: string };
    expect(again).toEqual(row);
  });

  it("respects an owner-rename: a row named by the owner keeps its name (only the root follows the boot)", () => {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, color, created_at)
       VALUES (?, 'My Sandbox', ?, '#64748B', '2026-08-19T00:00:00Z')`,
    ).run(GENERAL_PROJECT_ID, join(dataDir, "general"));

    ensureGeneralProject(db, dataDir);

    const row = db
      .prepare("SELECT name, root_path FROM projects WHERE id = ?")
      .get(GENERAL_PROJECT_ID) as { name: string; root_path: string };
    expect(row.name).toBe("My Sandbox");
    expect(row.root_path).toBe(join(dataDir, "scratchpad"));
  });

  it("DELETE /projects/general → 409 general_protected; the row survives and no event fires", async () => {
    ensureGeneralProject(db, dataDir);
    // A Scratchpad session exists — the protection must guard real data.
    createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: GENERAL_PROJECT_ID,
      title: "Scratch thought",
    });

    const frames: EventsBusFrame[] = [];
    const unsubscribe = getEventsBus().subscribe((frame) => frames.push(frame));
    try {
      const response = await authInject({
        method: "DELETE",
        url: `/api/v1/projects/${GENERAL_PROJECT_ID}`,
      });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error.code).toBe("general_protected");
      // R129-S (the rename): the message names the row by its R129 name.
      expect(body.error.message).toBe(
        "The Scratchpad project is the app's internal workspace — it cannot be deleted",
      );
    } finally {
      unsubscribe();
    }

    // The row + its session are untouched, and the bus stayed quiet.
    const listed = await authInject({ method: "GET", url: "/api/v1/projects" });
    const ids = (listed.json().projects as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(GENERAL_PROJECT_ID);
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(1);
    expect(frames).toEqual([]);
  });
});

describe("R128-W3 (SCREENS §2 law #8, backend half): the project delete cascade + event", () => {
  it("deletes the project AND its sessions' every dependent row, returns the counts, and publishes the deleted frame", async () => {
    const project = createProject(db, { name: "Cascade", rootPath: tempDir });
    // Two sessions with events + usage + an approval + a snapshot each, and
    // an unrelated session (different project) that must SURVIVE.
    const seedSession = (projectId: string | null, title: string) =>
      createSession(db, { agentId: "agt_scribe", mode: "single", projectId, title });
    const s1 = seedSession(project.id, "One");
    const s2 = seedSession(project.id, "Two");
    const bystander = seedSession(null, "Bystander");
    for (const session of [s1, s2]) {
      appendSessionEvent(db, session.id, {
        type: "message.user",
        agentId: "agt_scribe",
        payload: { role: "user", content: "hello", agentId: "agt_scribe", ts: new Date().toISOString() },
      });
      appendSessionEvent(db, session.id, {
        type: "message.assistant",
        agentId: "agt_scribe",
        payload: { role: "assistant", content: "hi", agentId: "agt_scribe", ts: new Date().toISOString() },
      });
      recordUsage(db, {
        agentId: "agt_scribe",
        sessionId: session.id,
        provider: "openrouter",
        model: "z-ai/glm-5.2:free",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
        ts: new Date().toISOString(),
      });
      createApproval(db, {
        sessionId: session.id,
        agentId: "agt_scribe",
        projectId: project.id,
        toolCall: "run_command: npm test",
        category: "command",
      });
      recordSnapshot(db, {
        sessionId: session.id,
        seq: 1,
        path: "src/index.ts",
        beforeContent: null,
        afterContent: "export const x = 1;\n",
        toolName: "write_file",
      });
    }
    // A codebase_index row rides the project FK (ON DELETE CASCADE).
    db.prepare(
      "INSERT INTO codebase_index (project_id, path, symbol, kind, line) VALUES (?, ?, ?, ?, ?)",
    ).run(project.id, "src/index.ts", "x", "const", 1);
    // The bystander's rows must survive the cascade.
    appendSessionEvent(db, bystander.id, {
      type: "message.user",
      agentId: "agt_scribe",
      payload: { role: "user", content: "stay", agentId: "agt_scribe", ts: new Date().toISOString() },
    });

    const frames: EventsBusFrame[] = [];
    const unsubscribe = getEventsBus().subscribe((frame) => frames.push(frame));
    let response: Awaited<ReturnType<typeof authInject>>;
    try {
      response = await authInject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
    } finally {
      unsubscribe();
    }

    // The route answers 200 with the honest cascade counts.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: project.id,
      deleted: {
        sessions: 2,
        sessionEvents: 4,
        usageEvents: 2,
        approvals: 2,
        fileSnapshots: 2,
      },
    });

    // Every dependent row is gone; the bystander is untouched.
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM projects")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM session_events")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM usage_events")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM approvals")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM file_snapshots")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM codebase_index")).toBe(0);

    // The events bus announced the deletion (the R113-a gap — deletes were
    // the only unannounced mutation).
    expect(frames).toContainEqual({ type: "project", projectId: project.id, kind: "deleted" });
  });

  it("deleting an unknown project stays an honest 404 with no event", async () => {
    const frames: EventsBusFrame[] = [];
    const unsubscribe = getEventsBus().subscribe((frame) => frames.push(frame));
    try {
      const response = await authInject({ method: "DELETE", url: "/api/v1/projects/ghost" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    } finally {
      unsubscribe();
    }
    expect(frames).toEqual([]);
  });
});
