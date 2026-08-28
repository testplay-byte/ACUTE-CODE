/**
 * ROUND-45 (R45-b) — PERSISTENT interactive terminal sessions (the round-44
 * "no PTY" deferral).
 *
 * Manager-level integration tests (agent-core/src/terminal-sessions.ts):
 *   - create/input/output round-trip on the PIPE engine (one long-lived
 *     bash — `echo hi` comes back as an output event within 5s),
 *   - cwd PERSISTS across inputs (mkdir + cd + pwd shows the subdir),
 *   - ring buffer caps at ringBufferBytes, dropping the OLDEST output,
 *   - kill() removes the session and emits an exit marker,
 *   - idle reaping with INJECTED short timings (never hardcode the 10 min),
 *   - per-project cap (3) evicts the OLDEST session of that project,
 *   - global cap (8) evicts the globally-oldest,
 *   - env scrubbing: process.env.ACUTE_TOKEN set before create → a child
 *     `node -e` sees NOTHING (P0-3 buildChildEnv allowlist),
 *   - list() is per-project,
 *   - node-pty round-trip (describe.skipIf(!loadable) — builds on this linux
 *     sandbox; must not fail where it cannot).
 *
 * Plus a focused ROUTE battery (the server.ts wiring): create 201/400/404,
 * input 400/404 + ownership, the SSE stream (leading ping + backlog frame +
 * exit frame, session survives a viewer leaving), DELETE 204/404, list.
 *
 * Platform note: the pipe/pty content assertions below speak BASH (`cd`,
 * `pwd`, `echo`). windows-latest has no bash semantics — the bash-dependent
 * describes skip on win32 (cmd.exe pipe engine is exercised by the live
 * battery on the owner's Windows machine instead).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  TerminalSessionManager,
  getTerminalSessions,
  isPtyLoadable,
  terminalSessionsDisposeAll,
  type TerminalSessionDescriptor,
  type TerminalSessionEvent,
} from "../src/terminal-sessions";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";

const TOKEN = "test-token-r45b";
const isWindows = process.platform === "win32";
const ptyLoadable = await isPtyLoadable();

// A REAL directory per test file: spawn(cwd) needs the project root to exist.
const dir = mkdtempSync(join(tmpdir(), "acute-terminal-sessions-"));
// projects.root_path is UNIQUE — the route tests' second project needs its
// own (equally real) root.
const otherDir = mkdtempSync(join(tmpdir(), "acute-terminal-sessions-other-"));

/** Managers created by the current test (disposed after each). */
const managers: TerminalSessionManager[] = [];

function newManager(
  options?: ConstructorParameters<typeof TerminalSessionManager>[0],
): TerminalSessionManager {
  const manager = new TerminalSessionManager(options);
  managers.push(manager);
  return manager;
}

/** Resolve when predicate() is truthy (poll; default 5s per the dispatch). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Subscribe + accumulate every event text/frame for one session. */
function collectEvents(
  manager: TerminalSessionManager,
  id: string,
): { events: TerminalSessionEvent[]; output: () => string } {
  const events: TerminalSessionEvent[] = [];
  manager.subscribe(id, (event) => events.push(event));
  return {
    events,
    output: () =>
      events
        .filter((e): e is { type: "output"; text: string } => e.type === "output")
        .map((e) => e.text)
        .join(""),
  };
}

/** Create a PIPE-engine session in the temp root (bash semantics). */
async function createPipeSession(
  manager: TerminalSessionManager,
  projectId = "prj_a",
  rootPath = dir,
): Promise<TerminalSessionDescriptor> {
  return manager.create({ projectId, rootPath, engine: "pipe" });
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  terminalSessionsDisposeAll();
});

afterAll(() => {
  for (const target of [dir, otherDir]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort: Windows sometimes holds file handles briefly after close.
    }
  }
});

describe.skipIf(isWindows)("TerminalSessionManager — pipe engine (bash)", () => {
  it("round-trips input → output events (echo hi comes back)", async () => {
    const manager = newManager();
    const session = await createPipeSession(manager);
    expect(session.engine).toBe("pipe");
    const collector = collectEvents(manager, session.id);

    manager.input(session.id, "echo hi");

    await waitFor(() => collector.output().includes("hi"));
    expect(manager.backlog(session.id)).toContain("hi");
  });

  it("PERSISTS cwd across inputs (mkdir + cd + pwd)", async () => {
    const sub = join(dir, "subdir-r45b");
    mkdirSync(sub, { recursive: true });
    const manager = newManager();
    const session = await createPipeSession(manager);
    const collector = collectEvents(manager, session.id);

    manager.input(session.id, "cd subdir-r45b");
    manager.input(session.id, "pwd");

    await waitFor(() => collector.output().includes("subdir-r45b"));
    // The SECOND command ran in the SAME shell — the state persisted.
    expect(collector.output()).toContain("subdir-r45b");
  });

  it("caps the ring buffer at ringBufferBytes, dropping the OLDEST output", async () => {
    const manager = newManager({ ringBufferBytes: 64 });
    const session = await createPipeSession(manager);
    const collector = collectEvents(manager, session.id);

    manager.input(session.id, "node -e \"process.stdout.write('a'.repeat(200))\"");

    await waitFor(() => collector.output().length >= 200);
    const backlog = manager.backlog(session.id);
    expect(backlog.length).toBe(64);
    // The TAIL survives (oldest dropped): 200 a's → the last 64 are all "a",
    // so assert via a tail marker instead.
    manager.input(session.id, "node -e \"process.stdout.write('HEAD' + 'b'.repeat(100) + 'TAIL')\"");
    await waitFor(() => manager.backlog(session.id).endsWith("TAIL"));
    const backlog2 = manager.backlog(session.id);
    expect(backlog2.length).toBeLessThanOrEqual(64);
    expect(backlog2.endsWith("TAIL")).toBe(true);
    expect(backlog2.includes("HEAD")).toBe(false);
  });

  it("kill() removes the session and emits an exit marker (code null)", async () => {
    const manager = newManager();
    const session = await createPipeSession(manager);
    const collector = collectEvents(manager, session.id);

    expect(manager.kill(session.id)).toBe(true);

    const exits = collector.events.filter((e) => e.type === "exit");
    expect(exits).toHaveLength(1);
    expect((exits[0] as { code: number | null }).code).toBeNull();
    expect(manager.get(session.id)).toBeNull();
    expect(manager.input(session.id, "echo gone")).toBe(false);
    expect(manager.list("prj_a")).toHaveLength(0);
    // Double kill is a clean miss, not a throw.
    expect(manager.kill(session.id)).toBe(false);
  });

  it("reaps idle sessions with INJECTED timings (no input for idleTimeoutMs)", async () => {
    const manager = newManager({ idleTimeoutMs: 200, sweepIntervalMs: 50 });
    const session = await createPipeSession(manager);
    const collector = collectEvents(manager, session.id);

    await waitFor(() => manager.get(session.id) === null, 3_000);
    const exits = collector.events.filter((e) => e.type === "exit");
    expect(exits).toHaveLength(1);
  });

  it("evicts the OLDEST session of a project past the per-project cap (3)", async () => {
    const manager = newManager();
    const first = await createPipeSession(manager, "prj_a");
    await createPipeSession(manager, "prj_a");
    await createPipeSession(manager, "prj_a");
    expect(manager.list("prj_a")).toHaveLength(3);

    // The 4th create kills the OLDEST (the first), not the newest.
    const fourth = await createPipeSession(manager, "prj_a");
    const list = manager.list("prj_a");
    expect(list).toHaveLength(3);
    expect(list.map((s) => s.id)).not.toContain(first.id);
    expect(list.map((s) => s.id)).toContain(fourth.id);
  });

  it("evicts the globally-oldest session past the global cap (8)", async () => {
    const manager = newManager();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      // 3 projects × 3 sessions = 9 creates against the 8-global cap.
      for (const project of ["pg1", "pg2", "pg3"]) {
        const s = await createPipeSession(manager, project);
        ids.push(s.id);
      }
    }
    // The 9th create evicted the globally-oldest (ids[0]); 8 remain.
    let total = 0;
    for (const project of ["pg1", "pg2", "pg3"]) total += manager.list(project).length;
    expect(total).toBe(8);
    expect(manager.get(ids[0])).toBeNull();
    expect(manager.get(ids[8])).not.toBeNull();
  });

  it("scrubs the sidecar's secrets out of the shell env (P0-3)", async () => {
    const previous = process.env.ACUTE_TOKEN;
    process.env.ACUTE_TOKEN = "r45b-super-secret-token";
    try {
      const manager = newManager();
      const session = await createPipeSession(manager);
      const collector = collectEvents(manager, session.id);

      manager.input(
        session.id,
        "node -e \"console.log(process.env.ACUTE_TOKEN || 'clean')\"",
      );

      await waitFor(() => collector.output().includes("clean"));
      expect(collector.output()).not.toContain("r45b-super-secret-token");
    } finally {
      if (previous === undefined) delete process.env.ACUTE_TOKEN;
      else process.env.ACUTE_TOKEN = previous;
    }
  });

  it("lists sessions per project with descriptors", async () => {
    const manager = newManager();
    const a1 = await createPipeSession(manager, "prj_a");
    await createPipeSession(manager, "prj_a");
    await createPipeSession(manager, "prj_b");

    const listA = manager.list("prj_a");
    expect(listA).toHaveLength(2);
    expect(listA[0]?.id).toBe(a1.id); // oldest first
    expect(listA.every((s) => s.projectId === "prj_a")).toBe(true);
    for (const s of listA) {
      expect(s.engine).toBe("pipe");
      expect(typeof s.createdAt).toBe("number");
    }
    expect(manager.list("prj_b")).toHaveLength(1);
    expect(manager.list("prj_none")).toHaveLength(0);
  });

  it("resize() is a no-op success on the pipe engine", async () => {
    const manager = newManager();
    const session = await createPipeSession(manager);
    expect(manager.resize(session.id, 100, 40)).toBe(true);
    // Session still works after the no-op resize.
    const collector = collectEvents(manager, session.id);
    manager.input(session.id, "echo still-alive");
    await waitFor(() => collector.output().includes("still-alive"));
  });

  it("subscribe() on an unknown session returns null", async () => {
    const manager = newManager();
    expect(manager.subscribe("ts_nope", () => {})).toBeNull();
  });

  it("a shell that exits on its own emits the exit marker with its code", async () => {
    const manager = newManager();
    const session = await createPipeSession(manager);
    const collector = collectEvents(manager, session.id);

    manager.input(session.id, "exit 7");

    await waitFor(() => manager.get(session.id) === null);
    const exits = collector.events.filter((e) => e.type === "exit");
    expect(exits).toHaveLength(1);
    expect((exits[0] as { code: number | null }).code).toBe(7);
  });
});

describe.skipIf(isWindows || !ptyLoadable)(
  "TerminalSessionManager — pty engine (node-pty loads here)",
  () => {
    it("is the DEFAULT engine when node-pty is loadable", async () => {
      const manager = newManager();
      const session = await manager.create({ projectId: "prj_pty", rootPath: dir });
      expect(session.engine).toBe("pty");
    });

    it("round-trips input → echo + output and kill() emits exit", async () => {
      const manager = newManager();
      const session = await manager.create({ projectId: "prj_pty", rootPath: dir });
      const collector = collectEvents(manager, session.id);

      // The pty ECHOES the command itself (that's the point of a pty).
      manager.input(session.id, "echo hi-pty\n");

      await waitFor(() => collector.output().includes("hi-pty"));
      expect(manager.backlog(session.id)).toContain("hi-pty");

      expect(manager.kill(session.id)).toBe(true);
      await waitFor(() =>
        collector.events.some((e) => e.type === "exit"),
      );
    });

    it("resize() reaches the pty without throwing", async () => {
      const manager = newManager();
      const session = await manager.create({ projectId: "prj_pty", rootPath: dir });
      expect(manager.resize(session.id, 100, 40)).toBe(true);
      const collector = collectEvents(manager, session.id);
      manager.input(session.id, "echo after-resize\n");
      await waitFor(() => collector.output().includes("after-resize"));
    });
  },
);

describe.skipIf(isWindows)("terminal-sessions REST+SSE routes (server.ts wiring)", () => {
  let db: SqliteDatabase;
  let app: FastifyInstance;
  let projectId = "";
  let otherProjectId = "";

  beforeEach(async () => {
    db = openDatabase(join(dir, `${randomUUID()}.db`));
    app = buildServer({ token: TOKEN, db });
    projectId = createProject(db, { name: "TermSessions", rootPath: dir }).id;
    otherProjectId = createProject(db, { name: "OtherRoot", rootPath: otherDir }).id;
  });

  afterEach(async () => {
    // The app's onClose hook disposes the singleton's sessions; the explicit
    // dispose is belt-and-braces for a failed close.
    terminalSessionsDisposeAll();
    await app.close();
    db.close();
  });

  async function authInject(options: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse> {
    return (await app.inject({
      ...options,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
  }

  async function createSessionViaRoute(
    payload?: Record<string, unknown>,
  ): Promise<{ status: number; body: { id?: string; engine?: string; createdAt?: number } }> {
    const response = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions`,
      payload,
    });
    return { status: response.statusCode, body: response.json() };
  }

  it("creates a session (201 + descriptor) and validates cols/rows", async () => {
    const { status, body } = await createSessionViaRoute({ cols: 100, rows: 30 });
    expect(status).toBe(201);
    expect(typeof body.id).toBe("string");
    expect(["pty", "pipe"]).toContain(body.engine);
    expect(typeof body.createdAt).toBe("number");

    // Out-of-range / non-integer dims → 400 with the field in details.
    for (const [payload, field] of [
      [{ cols: 19 }, "body.cols"],
      [{ cols: 501 }, "body.cols"],
      [{ cols: 90.5 }, "body.cols"],
      [{ rows: 9 }, "body.rows"],
      [{ rows: 201 }, "body.rows"],
      [{ rows: "tall" }, "body.rows"],
    ] as [Record<string, unknown>, string][]) {
      const bad = await createSessionViaRoute(payload);
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({
        error: { code: "VALIDATION", details: { field } },
      });
    }
  });

  it("404s on an unknown project", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/projects/prj_nope/terminal-sessions",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("lists the project's sessions (empty → one after create)", async () => {
    const empty = await authInject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/terminal-sessions`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().sessions).toEqual([]);

    await createSessionViaRoute();
    const listed = await authInject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/terminal-sessions`,
    });
    expect(listed.json().sessions).toHaveLength(1);
    expect(listed.json().sessions[0]).toMatchObject({ projectId: projectId });
  });

  it("input: 204 happy path, 400 on bad payload, 404 on unknown/cross-project session", async () => {
    const { body } = await createSessionViaRoute();
    const tsid = body.id as string;

    const ok = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "echo via-route" },
    });
    expect(ok.statusCode).toBe(204);

    const badType = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: 42 },
    });
    expect(badType.statusCode).toBe(400);

    const tooBig = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "x".repeat(9_000) },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error.details).toMatchObject({ field: "body.data" });

    const unknown = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/ts_nope/input`,
      payload: { data: "hi" },
    });
    expect(unknown.statusCode).toBe(404);

    // A session of ANOTHER project must not be addressable through this
    // project's route (no cross-project session-id leaks).
    const cross = await authInject({
      method: "POST",
      url: `/api/v1/projects/${otherProjectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "hi" },
    });
    expect(cross.statusCode).toBe(404);
  });

  it("streams backlog + live chunks + exit frame over SSE (session survives the viewer)", async () => {
    const { body } = await createSessionViaRoute();
    const tsid = body.id as string;

    // Produce output BEFORE any viewer connects (goes to the ring buffer).
    // Note the explicit \n: the route writes pty input RAW (control
    // sequences pass through), so the caller submits lines itself.
    await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "echo backlog-marker\n" },
    });
    await waitFor(() => getTerminalSessions().backlog(tsid).includes("backlog-marker"));

    // Open the viewer (not awaited — the response only ends when the shell
    // exits), then end the shell from a second request.
    const streamPromise = authInject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/stream`,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "exit 0\n" },
    });

    const response = await streamPromise;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const streamBody = response.body as string;
    expect(streamBody.startsWith(": ping\n\n")).toBe(true);

    type Frame =
      | { type: "output"; text: string }
      | { type: "exit"; code: number | null }
      | { type: "error"; message: string };
    const frames: Frame[] = [];
    for (const block of streamBody.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Frame);
      }
    }
    // Backlog arrives as ONE leading output frame, then live output, then
    // the terminal exit frame.
    const firstOutput = frames.find((f) => f.type === "output");
    expect((firstOutput as { text: string }).text).toContain("backlog-marker");
    const exits = frames.filter((f) => f.type === "exit");
    expect(exits).toHaveLength(1);
    expect((exits[0] as { code: number | null }).code).toBe(0);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  it("stream: 404 for an unknown session (validation precedes the hijack)", async () => {
    const response = await authInject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/terminal-sessions/ts_nope/stream`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("DELETE kills the session (204) and it is gone afterwards (404)", async () => {
    const { body } = await createSessionViaRoute();
    const tsid = body.id as string;

    const kill = await authInject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}`,
    });
    expect(kill.statusCode).toBe(204);

    const after = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`,
      payload: { data: "echo too-late" },
    });
    expect(after.statusCode).toBe(404);

    const redelete = await authInject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}`,
    });
    expect(redelete.statusCode).toBe(404);
  });

  it("resize: 204 with valid dims, 400 when missing/out-of-range", async () => {
    const { body } = await createSessionViaRoute();
    const tsid = body.id as string;

    const ok = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/resize`,
      payload: { cols: 120, rows: 40 },
    });
    expect(ok.statusCode).toBe(204);

    const missing = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/resize`,
      payload: { cols: 120 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details).toMatchObject({ field: "body.rows" });

    const unknown = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal-sessions/ts_nope/resize`,
      payload: { cols: 120, rows: 40 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
