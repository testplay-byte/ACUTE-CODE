/**
 * ROUND-44 (R44-e) — STREAMING terminal (owner directive "complete the
 * agentic coding environment").
 *
 * POST /projects/:id/terminal/stream is the SSE twin of the ROUND-38 sync
 * terminal runner: same containment (project existence, command required,
 * project-root cwd, FORCE_COLOR=0/CI=1 env, 60s timeout budget, 64 KB output
 * cap) but stdout/stderr stream as they arrive and the real exit code lands
 * in a terminal frame. These tests pin the frame protocol end-to-end through
 * app.inject (the reply is hijacked; light-my-request still captures the raw
 * writeHead/write/end calls, so the full SSE body is assertable):
 *
 *   - happy path: `echo hello` → stdout frame + exit 0 frame + SSE headers,
 *   - failing command: exit code 3 surfaces in the exit frame,
 *   - stderr is distinguished from stdout,
 *   - unknown project → 404 envelope; empty command / bad budget overrides
 *     → 400 (validation happens BEFORE the hijack),
 *   - timeout kill (tiny timeoutMs override) → error frame, no exit frame,
 *   - output cap (tiny maxBytes override) → truncated stdout + error frame,
 *     exit frame suppressed (we killed it; no honest exit code exists).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";

const TOKEN = "test-token-r44e";

// A REAL directory: spawn(cwd) needs the project root to exist.
const dir = mkdtempSync(join(tmpdir(), "acute-terminal-stream-"));

let db: SqliteDatabase;
let app: FastifyInstance;
let projectId = "";

beforeEach(() => {
  db = openDatabase(join(dir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
  projectId = createProject(db, { name: "StreamTerm", rootPath: dir }).id;
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

/** Authenticated inject (the bearer wall covers every route but /health). */
async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  const response = (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
  return response;
}

type StreamFrame =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number | null; ms: number }
  | { type: "error"; message: string };

/** Parse an SSE body into its `data:` frames (comment frames like `: ping`
 * are skipped — mirrors the frontend parser in src/lib/api.ts). */
function parseFrames(body: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        frames.push(JSON.parse(line.slice(6)) as StreamFrame);
      }
    }
  }
  return frames;
}

/** POST a command on the streaming route and return status + frames. */
async function streamCommand(
  command: string,
  overrides?: { timeoutMs?: number; maxBytes?: number },
): Promise<{ status: number; headers: Record<string, string>; body: string; frames: StreamFrame[] }> {
  const response = await authInject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/terminal/stream`,
    payload: { command, ...overrides },
  });
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string>,
    body: response.body,
    frames: response.statusCode === 200 ? parseFrames(response.body) : [],
  };
}

describe("POST /projects/:id/terminal/stream (ROUND-44 R44-e)", () => {
  it("streams `echo hello` as a stdout frame + exit 0 frame with SSE headers", async () => {
    const { status, headers, body, frames } = await streamCommand("echo hello");

    expect(status).toBe(200);
    // The chat-stream header block, verbatim (ROUND-30: hijack drops
    // reply.header() values — these must ride writeHead).
    expect(headers["content-type"]).toContain("text/event-stream");
    expect(headers["cache-control"]).toContain("no-cache");
    expect(headers["connection"]).toBe("keep-alive");

    const stdout = frames.filter((f) => f.type === "stdout");
    expect(stdout).toHaveLength(1);
    // ROUND-44 CI fix: cmd.exe's `echo hello` emits CRLF on windows-latest —
    // normalize line endings before asserting (the assertion is about the
    // frame PLUMBING, not platform newline conventions).
    expect((stdout[0] as { text: string }).text.replace(/\r\n/g, "\n")).toBe("hello\n");

    const exits = frames.filter((f) => f.type === "exit");
    expect(exits).toHaveLength(1);
    expect((exits[0] as { code: number; ms: number }).code).toBe(0);
    expect((exits[0] as { ms: number }).ms).toBeGreaterThanOrEqual(0);
    // No error frames on a clean run. The LEADING `: ping` comment frame
    // flushes the headers immediately (a quiet command must not wait 10s for
    // its first byte); no further heartbeat ticks for a millisecond-lived
    // stream, and comment frames are ignored by the client parser.
    expect(frames.some((f) => f.type === "error")).toBe(false);
    expect(body.startsWith(": ping\n\n")).toBe(true);
    expect(body.split(": ping").length - 1).toBe(1);
  });

  it("streams the real exit code for a failing command", async () => {
    const { frames } = await streamCommand('node -e "process.exit(3)"');

    const exits = frames.filter((f) => f.type === "exit");
    expect(exits).toHaveLength(1);
    expect((exits[0] as { code: number }).code).toBe(3);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  it("distinguishes stderr chunks from stdout chunks", async () => {
    const { frames } = await streamCommand(
      'node -e "process.stderr.write(\'boom\'); process.stdout.write(\'ok\')"',
    );

    const stderr = frames.filter((f) => f.type === "stderr");
    expect(stderr).toHaveLength(1);
    expect((stderr[0] as { text: string }).text).toBe("boom");
    const stdout = frames.filter((f) => f.type === "stdout");
    expect(stdout).toHaveLength(1);
    expect((stdout[0] as { text: string }).text).toBe("ok");
    const exits = frames.filter((f) => f.type === "exit");
    expect((exits[0] as { code: number }).code).toBe(0);
  });

  it("404s for an unknown project (validation precedes the hijack)", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/projects/prj_nope/terminal/stream",
      payload: { command: "echo hello" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("400s on an empty command and on out-of-range budget overrides", async () => {
    const empty = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal/stream`,
      payload: { command: "   " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("VALIDATION");

    // Overrides can only SHRINK the budgets: >60s timeout and <256-byte caps
    // are rejected with the field name in details.
    const badTimeout = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal/stream`,
      payload: { command: "echo hello", timeoutMs: 61_000 },
    });
    expect(badTimeout.statusCode).toBe(400);
    expect(badTimeout.json().error.details).toMatchObject({ field: "body.timeoutMs" });

    const badCap = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal/stream`,
      payload: { command: "echo hello", maxBytes: 10 },
    });
    expect(badCap.statusCode).toBe(400);
    expect(badCap.json().error.details).toMatchObject({ field: "body.maxBytes" });

    const badType = await authInject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/terminal/stream`,
      payload: { command: "echo hello", timeoutMs: "fast" },
    });
    expect(badType.statusCode).toBe(400);
  });

  it("kills a slow command at timeoutMs and ends with an error frame (no exit frame)", async () => {
    const { frames } = await streamCommand('node -e "setTimeout(() => {}, 8000)"', {
      timeoutMs: 400,
    });

    const errors = frames.filter((f) => f.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toBe("timed out after 400ms");
    // The timeout error IS the terminal frame — no exit code exists for a
    // command we killed.
    expect(frames.some((f) => f.type === "exit")).toBe(false);
  });

  it("caps total output at maxBytes: truncated stdout + error frame, exit suppressed", async () => {
    const { frames } = await streamCommand(
      'node -e "process.stdout.write(\'a\'.repeat(2048))"',
      { maxBytes: 256 },
    );

    const stdout = frames.filter((f) => f.type === "stdout");
    // Whatever the pipe chunking, exactly maxBytes bytes survive in total.
    const total = stdout.reduce((n, f) => n + (f as { text: string }).text.length, 0);
    expect(total).toBe(256);

    const errors = frames.filter((f) => f.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain(
      "output exceeded 256 bytes — command killed (output truncated)",
    );
    // We killed it — no honest exit code, so no exit frame.
    expect(frames.some((f) => f.type === "exit")).toBe(false);
  });
});
