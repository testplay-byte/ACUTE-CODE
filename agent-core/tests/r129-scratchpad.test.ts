/**
 * ROUND-129 (R129-S, SCREENS.md §2 laws #8 + #9 — the Scratchpad) — the
 * backend suite for the per-session workspace rework:
 *
 *   1. MIGRATION 0043: sessions.root_path — createSession persists the
 *      input's rootPath (conditional column), getSession maps it back
 *      (fail-open null for garbage), absent input stays NULL.
 *   2. THE CREATE PATH: POST /sessions with projectId "general" creates
 *      <dataDir>/scratchpad/<sessionId>/ and the 202 body carries it
 *      (truthful re-read); a NORMAL project's session gets NO folder and
 *      rootPath null; two Scratchpad sessions get TWO different folders
 *      (the independence law).
 *   3. THE DELETE PATH: deleting a Scratchpad session removes its folder
 *      with the row — while a sibling Scratchpad folder survives and a
 *      NORMAL session's project files are untouched (law #8: records
 *      only).
 *   4. THE CONTAINMENT GUARD: removeScratchpadSessionWorkspace refuses
 *      null, the scratchpad root itself, `..` escapes, deeper paths, and
 *      a folder a LIVE session row still references; removes a genuine
 *      direct child (idempotent on an already-gone folder).
 *   5. THE RUNTIME THREADING: a Scratchpad session's turn resolves the
 *      system prompt's "PROJECT: … at <root>" + working-directory +
 *      custom-rules lines against the SESSION's folder (not the project
 *      root), and the codebase-index section is SKIPPED (the project
 *      index would describe a workspace the model never sees).
 *   6. THE METER MIRROR (the R83 one-truth law): the context meter's meta
 *      slice follows the SAME effective root — a session-folder AGENTS.md
 *      counts, the project root's does not.
 *   7. THE FORK PATH: forking a Scratchpad session hands the FORK its own
 *      folder — never the source's (the every-session-independent law).
 *   8. THE CHILD PATH (the orchestrator's db-derived helper): a child of
 *      a Scratchpad parent gets its own folder under the same root; a
 *      normal project's child gets none.
 *   9. THE CREATE HELPER'S DIRECT CONTRACT (R129-S-finish — the unit pins
 *      the route path exercises indirectly): ensureScratchpadSessionWorkspace
 *      returns null (and touches nothing) for a non-general project, is
 *      IDEMPOTENT (same folder, same row value on the second call), and a
 *      mkdir failure is LOGGED (lib/log.ts's error channel) and returns
 *      null WITHOUT the row update — the session falls back to the project
 *      root and still works.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route suite runs the real aiSdkChat adapter with ONLY the AI SDK
// mocked at the module boundary (sessions.test.ts's idiom) — the sync
// POST /messages path then runs the REAL prepareTurn against our rows.
// jsonSchema passes through as-is (the r95-thinking-levels idiom):
// prepareTurn → buildProjectTools wraps its input schemas with it — the
// mock must provide it or createTools dies on a non-function.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createProject } from "../src/storage/projects";
import {
  createSession,
  getSession,
} from "../src/storage/sessions";
import {
  ensureGeneralProject,
  ensureScratchpadChildWorkspace,
  ensureScratchpadSessionWorkspace,
  GENERAL_PROJECT_ID,
  removeScratchpadSessionWorkspace,
  scratchpadRoot,
} from "../src/storage/general-project";
import { ProviderKeyring } from "../src/providers/registry";

const TOKEN = "test-token-r129s";
const KEY = "sk-or-vtest-r129s";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r129-s-"));
  dataDir = mkdtempSync(join(tmpdir(), "acute-r129-data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    // R129-S: the data dir the Scratchpad workspace helpers key on.
    dataDir,
  });
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "Fixed reply.",
    usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
  });
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

/** SQLite's native ts format ("YYYY-MM-DD HH:MM:SS", UTC) — what the
 * index staleness gate parses; an ISO string reads as unparseable → stale
 * → the auto-index would wipe the seeded rows mid-test. */
const sqliteUtcNow = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

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

async function createAgent(): Promise<{ id: string }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Scratch Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.2,
      maxTurns: 8,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createSessionViaRoute(payload: {
  agentId: string;
  projectId?: string;
  title?: string;
}): Promise<{ id: string; rootPath: string | null }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { mode: "single", ...payload },
  });
  expect(response.statusCode).toBe(202);
  return response.json();
}

// ── 1. MIGRATION 0043: the sessions.root_path column ─────────────────────────

describe("R129-S migration 0043: sessions.root_path", () => {
  it("createSession persists a provided rootPath and getSession maps it back", () => {
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: null,
      title: "With root",
      rootPath: "/tmp/acute-r129-root",
    });
    expect(session.rootPath).toBe("/tmp/acute-r129-root");
    // The durable column (migration 0043 applied by openDatabase).
    const row = db
      .prepare("SELECT root_path FROM sessions WHERE id = ?")
      .get(session.id) as { root_path: string | null };
    expect(row.root_path).toBe("/tmp/acute-r129-root");
    const fetched = getSession(db, session.id);
    expect(fetched?.rootPath).toBe("/tmp/acute-r129-root");
  });

  it("absent rootPath stays NULL (every normal session — the pre-R129 behavior)", () => {
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: null,
      title: "Rootless",
    });
    expect(session.rootPath).toBeNull();
    const row = db
      .prepare("SELECT root_path FROM sessions WHERE id = ?")
      .get(session.id) as { root_path: string | null };
    expect(row.root_path).toBeNull();
  });

  it("the read is fail-open: a garbage/empty root_path reads as null", () => {
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: null,
      title: "Corrupt",
    });
    db.prepare("UPDATE sessions SET root_path = '' WHERE id = ?").run(session.id);
    expect(getSession(db, session.id)?.rootPath).toBeNull();
  });
});

// ── 2. THE CREATE PATH: the Scratchpad session's OWN folder ─────────────────

describe("R129-S (law #9): POST /sessions creates the Scratchpad session's own workspace", () => {
  it("a Scratchpad session gets <dataDir>/scratchpad/<id>/ and the 202 body carries it", async () => {
    ensureGeneralProject(db, dataDir);
    const agent = await createAgent();
    const session = await createSessionViaRoute({
      agentId: agent.id,
      projectId: GENERAL_PROJECT_ID,
      title: "Scratch thought",
    });
    const expectedRoot = join(scratchpadRoot(dataDir), session.id);
    expect(session.rootPath).toBe(expectedRoot);
    expect(existsSync(expectedRoot)).toBe(true);
    // The row is truthful too (the helper's UPDATE landed).
    expect(getSession(db, session.id)?.rootPath).toBe(expectedRoot);
  });

  it("a NORMAL project's session gets NO folder and rootPath null", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "acute-r129-proj-"));
    try {
      const project = createProject(db, { name: "Normal", rootPath: projectRoot });
      const agent = await createAgent();
      const session = await createSessionViaRoute({
        agentId: agent.id,
        projectId: project.id,
        title: "Normal chat",
      });
      expect(session.rootPath).toBeNull();
      // Nothing appeared under the scratchpad root for a normal session.
      expect(existsSync(scratchpadRoot(dataDir))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("two Scratchpad sessions get TWO different folders (the independence law)", async () => {
    ensureGeneralProject(db, dataDir);
    const agent = await createAgent();
    const first = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    const second = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    expect(first.rootPath).not.toBe(second.rootPath);
    expect(existsSync(first.rootPath as string)).toBe(true);
    expect(existsSync(second.rootPath as string)).toBe(true);
  });
});

// ── 3. THE DELETE PATH: the folder dies with the row — and ONLY the
//        Scratchpad's folders die ─────────────────────────────────────────────

describe("R129-S (laws #8 + #9): DELETE /sessions/:id removes the Scratchpad folder with the row", () => {
  it("deletes a Scratchpad session's folder — and ONLY that folder", async () => {
    ensureGeneralProject(db, dataDir);
    const agent = await createAgent();
    const doomed = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    const sibling = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    // Real content in both folders (the folder removal must take the files).
    writeFileSync(join(doomed.rootPath as string, "scratch.txt"), "doomed scratch data");
    writeFileSync(join(sibling.rootPath as string, "keep.txt"), "sibling scratch data");

    const response = await authInject({ method: "DELETE", url: `/api/v1/sessions/${doomed.id}` });
    expect(response.statusCode).toBe(204);
    expect(existsSync(doomed.rootPath as string)).toBe(false);
    // The sibling's folder + file survive; the scratchpad root survives.
    expect(existsSync(join(sibling.rootPath as string, "keep.txt"))).toBe(true);
    expect(existsSync(scratchpadRoot(dataDir))).toBe(true);
  });

  it("a NORMAL session's delete touches NO files (law #8: records only)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "acute-r129-files-"));
    try {
      const project = createProject(db, { name: "Files", rootPath: projectRoot });
      const agent = await createAgent();
      const session = await createSessionViaRoute({
        agentId: agent.id,
        projectId: project.id,
      });
      // The project's own file on disk — must survive the session delete.
      const userFile = join(projectRoot, "owner-notes.txt");
      writeFileSync(userFile, "the owner's own file");

      const response = await authInject({ method: "DELETE", url: `/api/v1/sessions/${session.id}` });
      expect(response.statusCode).toBe(204);
      expect(existsSync(userFile)).toBe(true);
      expect(existsSync(projectRoot)).toBe(true);
      // The session row is gone (the records-only half did run).
      expect(getSession(db, session.id)).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ── 4. THE CONTAINMENT GUARD ────────────────────────────────────────────────

describe("R129-S: removeScratchpadSessionWorkspace's path-shape guard", () => {
  it("refuses null, the root itself, `..` escapes, deeper paths, and live-referenced folders", () => {
    const root = scratchpadRoot(dataDir);
    mkdirSync(root, { recursive: true });

    // null (a NORMAL session) and empty — nothing qualifies.
    expect(removeScratchpadSessionWorkspace(db, dataDir, null)).toBe(false);
    expect(removeScratchpadSessionWorkspace(db, dataDir, "")).toBe(false);
    // The scratchpad ROOT itself is not a session folder (its resolved
    // parent is the data dir, not the root).
    expect(removeScratchpadSessionWorkspace(db, dataDir, root)).toBe(false);
    // A `..` escape resolves OUTSIDE the root — refused.
    expect(removeScratchpadSessionWorkspace(db, dataDir, join(root, "..", "escape"))).toBe(false);
    // A DEEPER path (a child of a session folder, not a direct child) — refused.
    expect(removeScratchpadSessionWorkspace(db, dataDir, join(root, "sess_x", "nested"))).toBe(false);
    // An unrelated direct child of the DATA dir — refused.
    expect(removeScratchpadSessionWorkspace(db, dataDir, join(dataDir, "elsewhere"))).toBe(false);

    // Nothing was removed by the refusals above.
    expect(existsSync(dataDir)).toBe(true);
  });

  it("removes a genuine direct child (idempotent when it is already gone) — and refuses one a LIVE row still references", () => {
    const root = scratchpadRoot(dataDir);
    const target = join(root, "sess_livecheck");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "data.txt"), "session data");

    // A live session row still claiming the path → the belt-and-braces leg
    // refuses (a mis-ordered caller must never remove a folder another
    // session calls its workspace).
    const live = createSession(db, { agentId: "agt_scribe", mode: "single", projectId: null, title: "Live" });
    db.prepare("UPDATE sessions SET root_path = ? WHERE id = ?").run(target, live.id);
    expect(removeScratchpadSessionWorkspace(db, dataDir, target)).toBe(false);
    expect(existsSync(target)).toBe(true);

    // Row gone → the folder goes with it.
    db.prepare("DELETE FROM sessions WHERE id = ?").run(live.id);
    expect(removeScratchpadSessionWorkspace(db, dataDir, target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    // Idempotent: force-tolerates the already-removed folder.
    expect(removeScratchpadSessionWorkspace(db, dataDir, target)).toBe(true);
  });
});

// ── 5. THE RUNTIME THREADING: prepareTurn's effective root ─────────────────

describe("R129-S: prepareTurn resolves a Scratchpad session against ITS OWN folder", () => {
  it("the system prompt names the SESSION folder, reads ITS custom rules, and skips the project index", async () => {
    ensureGeneralProject(db, dataDir);
    // The PROJECT root gets its own marker rules + an index row: BOTH must
    // be invisible to a scratchpad session's turn.
    writeFileSync(join(scratchpadRoot(dataDir), "AGENTS.md"), "PROJROOT_MARKER: never read this.");
    db.prepare(
      "INSERT INTO codebase_index (project_id, path, symbol, kind, line, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(GENERAL_PROJECT_ID, "src/index.ts", "x", "const", 1, sqliteUtcNow());

    const agent = await createAgent();
    const session = await createSessionViaRoute({
      agentId: agent.id,
      projectId: GENERAL_PROJECT_ID,
    });
    // The SESSION folder's own convention file — the one the turn must read.
    writeFileSync(join(session.rootPath as string, "AGENTS.md"), "SESSIONROOT_MARKER: the session folder is the workspace.");

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "hello scratchpad" },
    });
    expect(response.statusCode).toBe(200);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as { system: string };
    // The PROJECT line + working directory name the SESSION's folder (the
    // model must believe its workspace is that folder).
    expect(call.system).toContain(`PROJECT: "Scratchpad" at ${session.rootPath}`);
    expect(call.system).toContain(`- Working directory: ${session.rootPath} (all paths must be relative to this)`);
    // The session folder's custom rules ARE in; the project root's are NOT.
    expect(call.system).toContain("SESSIONROOT_MARKER: the session folder is the workspace.");
    expect(call.system).not.toContain("PROJROOT_MARKER");
    // The project's codebase index is SKIPPED — it describes the project
    // root, not the session's workspace (the index would lie).
    expect(call.system).not.toContain("### Project index");
  });

  it("a NORMAL session still carries the project root + its index (the pre-R129 behavior)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "acute-r129-normal-"));
    try {
      writeFileSync(join(projectRoot, "AGENTS.md"), "NORMALROOT_MARKER: the project root is the workspace.");
      const project = createProject(db, { name: "Normal", rootPath: projectRoot });
      db.prepare(
        "INSERT INTO codebase_index (project_id, path, symbol, kind, line, ts) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(project.id, "src/util.ts", "clamp", "function", 1, sqliteUtcNow());

      const agent = await createAgent();
      const session = await createSessionViaRoute({ agentId: agent.id, projectId: project.id });

      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages`,
        payload: { content: "hello normal" },
      });
      expect(response.statusCode).toBe(200);
      const call = generateTextMock.mock.calls[0][0] as { system: string };
      expect(call.system).toContain(`PROJECT: "Normal" at ${projectRoot}`);
      expect(call.system).toContain("NORMALROOT_MARKER: the project root is the workspace.");
      // The project index rides the prompt exactly as before R129.
      expect(call.system).toContain("### Project index");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ── 6. THE METER MIRROR (the R83 one-truth law) ─────────────────────────────

describe("R129-S: the context meter mirrors the turn's effective root", () => {
  it("a session-folder AGENTS.md counts into the meter's meta slice; the project root's does not", async () => {
    ensureGeneralProject(db, dataDir);
    const agent = await createAgent();
    const bare = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    const laden = await createSessionViaRoute({ agentId: agent.id, projectId: GENERAL_PROJECT_ID });
    // ~8KB of session-folder rules ≈ thousands of estimated tokens — the
    // delta between the two meters must be unmistakable.
    writeFileSync(
      join(laden.rootPath as string, "AGENTS.md"),
      "SESSION RULES\n" + "Always be precise and cite file:line for every claim.\n".repeat(160),
    );

    const meter = async (sessionId: string): Promise<number> => {
      const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
      expect(response.statusCode).toBe(200);
      return (response.json() as { breakdown: { meta: number } }).breakdown.meta;
    };
    const ladenMeta = await meter(laden.id);
    const bareMeta = await meter(bare.id);
    expect(ladenMeta - bareMeta).toBeGreaterThan(1000);
  });
});

// ── 7. THE FORK PATH ────────────────────────────────────────────────────────

describe("R129-S: forking a Scratchpad session hands the FORK its own folder", () => {
  it("the fork's rootPath is a NEW scratchpad folder — never the source's", async () => {
    ensureGeneralProject(db, dataDir);
    const agent = await createAgent();
    const source = await createSessionViaRoute({
      agentId: agent.id,
      projectId: GENERAL_PROJECT_ID,
      title: "Original",
    });
    writeFileSync(join(source.rootPath as string, "source.txt"), "the source's own file");

    const response = await authInject({ method: "POST", url: `/api/v1/sessions/${source.id}/fork` });
    expect(response.statusCode).toBe(201);
    const fork = (response.json() as { session: { id: string; rootPath: string | null } }).session;
    expect(fork.rootPath).toBe(join(scratchpadRoot(dataDir), fork.id));
    expect(fork.rootPath).not.toBe(source.rootPath);
    // Both folders exist; the source's file is untouched.
    expect(existsSync(fork.rootPath as string)).toBe(true);
    expect(existsSync(join(source.rootPath as string, "source.txt"))).toBe(true);
  });
});

// ── 9. THE CREATE HELPER'S DIRECT CONTRACT ───────────────────────────────────
// R129-S-finish: the interrupted prior run imported
// ensureScratchpadSessionWorkspace for exactly this block and never wrote
// it (TS6133) — restored here: the helper's own contract, pinned directly.

describe("R129-S: ensureScratchpadSessionWorkspace's direct contract", () => {
  it("returns null for a NON-general project — no folder, no row update", () => {
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: null,
      title: "Normal direct",
    });
    // A projectless (or normal-project) session never qualifies — the
    // helper must touch neither disk nor the row.
    expect(ensureScratchpadSessionWorkspace(db, dataDir, session.id, null)).toBeNull();
    expect(ensureScratchpadSessionWorkspace(db, dataDir, session.id, "prj_other")).toBeNull();
    expect(existsSync(scratchpadRoot(dataDir))).toBe(false);
    expect(getSession(db, session.id)?.rootPath).toBeNull();
  });

  it("creates the folder, updates the row, and is IDEMPOTENT", () => {
    ensureGeneralProject(db, dataDir);
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: GENERAL_PROJECT_ID,
      title: "Direct create",
    });
    const dir = ensureScratchpadSessionWorkspace(db, dataDir, session.id, GENERAL_PROJECT_ID);
    expect(dir).toBe(join(scratchpadRoot(dataDir), session.id));
    expect(existsSync(dir as string)).toBe(true);
    expect(getSession(db, session.id)?.rootPath).toBe(dir);

    // Idempotent: the second call re-mkdirs (recursive tolerates EEXIST)
    // and re-writes the SAME row value — never a second folder, never a
    // different value, never a throw.
    const again = ensureScratchpadSessionWorkspace(db, dataDir, session.id, GENERAL_PROJECT_ID);
    expect(again).toBe(dir);
    expect(existsSync(dir as string)).toBe(true);
    expect(getSession(db, session.id)?.rootPath).toBe(dir);
  });

  it("a mkdir failure is LOGGED and returns null WITHOUT the row update", () => {
    // The scratchpad ROOT's name occupied by a FILE → the recursive mkdir
    // of <root>/<sessionId> fails (ENOTDIR) — the exact read-only/unwritable
    // state-dir shape the helper's catch exists for.
    writeFileSync(scratchpadRoot(dataDir), "not a directory");
    ensureGeneralProject(db, dataDir);
    const session = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: GENERAL_PROJECT_ID,
      title: "Broken mkdir",
    });
    // lib/log.ts's error channel rides console.error (one JSON line per
    // event) — spy it so the assertion reads the helper's own logging.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(ensureScratchpadSessionWorkspace(db, dataDir, session.id, GENERAL_PROJECT_ID)).toBeNull();
      // The failure is never silent: one structured line names the event.
      expect(errorSpy).toHaveBeenCalled();
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("scratchpad.session_workspace_mkdir_failed"))).toBe(
        true,
      );
      // The row was NOT updated — the session falls back to the project
      // root (the pre-R129 behavior) and still works.
      expect(getSession(db, session.id)?.rootPath).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("R129-S: ensureScratchpadChildWorkspace (the orchestrator create-site helper)", () => {
  it("a child of a Scratchpad parent gets its OWN folder under the project row's root", () => {
    ensureGeneralProject(db, dataDir);
    // A real parent row (the FK on parent_session_id points at sessions).
    const parent = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: GENERAL_PROJECT_ID,
      title: "Parent",
    });
    const child = createSession(db, {
      agentId: "agt_scribe",
      mode: "single",
      projectId: GENERAL_PROJECT_ID,
      parentSessionId: parent.id,
      subRole: "researcher",
      title: "Child",
    });
    const path = ensureScratchpadChildWorkspace(db, child.id, GENERAL_PROJECT_ID);
    expect(path).toBe(join(scratchpadRoot(dataDir), child.id));
    expect(existsSync(path as string)).toBe(true);
    expect(getSession(db, child.id)?.rootPath).toBe(path);
  });

  it("a normal project's child (and a missing project row) get NO folder", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "acute-r129-child-"));
    try {
      const project = createProject(db, { name: "Normal", rootPath: projectRoot });
      const parent = createSession(db, {
        agentId: "agt_scribe",
        mode: "single",
        projectId: project.id,
        title: "Parent",
      });
      const child = createSession(db, {
        agentId: "agt_scribe",
        mode: "single",
        projectId: project.id,
        parentSessionId: parent.id,
        subRole: "coder",
        title: "Child",
      });
      expect(ensureScratchpadChildWorkspace(db, child.id, project.id)).toBeNull();
      expect(getSession(db, child.id)?.rootPath).toBeNull();
      // No project row at all → null (the honest degraded answer).
      expect(ensureScratchpadChildWorkspace(db, "sess_ghost", GENERAL_PROJECT_ID)).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
