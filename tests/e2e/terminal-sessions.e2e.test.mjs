// Black-box E2E for the ROUND-45 persistent terminal sessions (R45-b routes,
// R46-d coverage): spawns the BUILT sidecar (agent-core/dist/main.js) with its
// own token + temp DB and drives the terminal-session REST/SSE family exactly
// like the UI does — create → list → resize → live SSE stream (output frames +
// exit frame + response END) → post-exit 404s, plus DELETE-kill and the
// unknown-project guard.
//
// Self-skips without a prior build (like sidecar.e2e.test.mjs — `pnpm test`
// runs before `pnpm build`; `pnpm verify` runs this after it). The
// bash-arithmetic test also self-skips on win32 (cmd.exe has no $((…)) —
// the same platform honesty as agent-core/tests/terminal-sessions.test.ts;
// the live Windows battery covers the pipe engine there).
//
// Engine-agnostic BY DESIGN: the create response reports the engine chosen on
// THIS machine (pty when node-pty loads, pipe otherwise) — assertions accept
// either. The streamed marker `r46d_$((6*7))` is COMPUTED BY THE SHELL, so a
// passing "r46d_42" assertion proves real command execution on either engine
// (the literal command string never contains it).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const MAIN_JS = join(REPO_ROOT, "agent-core", "dist", "main.js");
const TOKEN = "e2e-terminal-token";
const isWindows = process.platform === "win32";

// Generous SSE-reader budgets (seconds) — a CI VM's first pty spawn can be
// slow; these only ever bite when something is actually broken.
const T_PING_MS = 15_000;
const T_OUTPUT_MS = 20_000;
const T_EXIT_MS = 20_000;
const T_END_MS = 10_000;

let child;
let baseUrl;
let tempDir;

function killTree(pid) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    child?.kill("SIGKILL");
  }
}

async function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar not ready in 15s")), 15000);
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n").find((l) => l.startsWith("ACUTE_READY"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice("ACUTE_READY ".trim().length)).port);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sidecar exited early (code ${code})`));
    });
  });
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204s have no body */
  }
  return { status: res.status, json };
}

/** Create a project whose root is a fresh real directory (unique per call). */
async function createProject(label) {
  const root = mkdtempSync(join(tempDir, `root-${label}-`));
  const created = await api("POST", "/api/v1/projects", { name: `e2e terminal ${label}`, rootPath: root });
  assert.equal(created.status, 201, `project create failed: ${JSON.stringify(created.json)}`);
  return created.json.id;
}

// ── SSE plumbing (a tiny custom reader with explicit budgets) ───────────────

/**
 * Opens the terminal-session SSE viewer. Frames accumulate in `state.frames`
 * (parsed `data:` payloads), raw bytes in `state.raw` (bounded — enough to
 * assert the leading ping), `state.ended` flips when the response ends.
 */
async function openTerminalStream(projectId, tsid) {
  const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/terminal-sessions/${tsid}/stream`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, `stream open failed: ${res.status}`);
  assert.equal((res.headers.get("content-type") ?? "").split(";")[0], "text/event-stream");
  const state = { raw: "", pending: "", frames: [], ended: false };
  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (state.raw.length < 512) state.raw += text;
        state.pending += text;
        let idx;
        while ((idx = state.pending.indexOf("\n\n")) !== -1) {
          const block = state.pending.slice(0, idx);
          state.pending = state.pending.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                state.frames.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore non-JSON data lines */
              }
            }
          }
        }
      }
    } catch {
      /* socket teardown — `ended` below is what matters */
    }
    state.ended = true;
  })();
  return state;
}

function framesSummary(state) {
  return JSON.stringify(state.frames).slice(0, 500);
}

async function waitForFrame(state, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = state.frames.find(predicate);
    if (found !== undefined) return found;
    if (state.ended) throw new Error(`stream ended before ${label} — frames: ${framesSummary(state)}`);
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} — frames: ${framesSummary(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForStreamEnd(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!state.ended) {
    if (Date.now() > deadline) throw new Error(`stream did not END within ${timeoutMs}ms — frames: ${framesSummary(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Resolve once the first raw bytes arrived (the leading `: ping`). */
async function waitForFirstBytes(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (state.raw === "") {
    if (state.ended) throw new Error(`stream ended before any bytes — frames: ${framesSummary(state)}`);
    if (Date.now() > deadline) throw new Error(`no bytes arrived within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Concatenated text of every output frame (marker matching is chunk-safe). */
function outputText(state) {
  return state.frames
    .filter((frame) => frame.type === "output")
    .map((frame) => frame.text)
    .join("");
}

beforeAll(async () => {
  if (!existsSync(MAIN_JS)) return;
  tempDir = mkdtempSync(join(tmpdir(), "acute-e2e-terminal-"));
  child = spawn(process.execPath, [MAIN_JS], {
    cwd: REPO_ROOT,
    env: { ...process.env, ACUTE_TOKEN: TOKEN, ACUTE_DB_PATH: join(tempDir, "e2e.db") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await waitForReady(child);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  if (child?.pid) killTree(child.pid);
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Windows may briefly hold handles */
    }
  }
});

describe("terminal sessions e2e (skipped without a prior build)", { skip: !existsSync(MAIN_JS) }, () => {
  it("creates a session (engine pty|pipe, reported by the server), lists it, and resizes it", async () => {
    const projectId = await createProject("crud");
    const created = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions`, { cols: 120, rows: 30 });
    assert.equal(created.status, 201, `session create failed: ${JSON.stringify(created.json)}`);
    const { id, engine, createdAt } = created.json;
    assert.match(id, /^[\w-]+$/);
    assert.ok(["pty", "pipe"].includes(engine), `engine must be pty|pipe, got '${engine}'`);
    assert.ok(typeof createdAt === "number" && createdAt > 0);

    const listed = await api("GET", `/api/v1/projects/${projectId}/terminal-sessions`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.sessions.length, 1);
    assert.equal(listed.json.sessions[0].id, id);
    assert.equal(listed.json.sessions[0].engine, engine);
    assert.equal(listed.json.sessions[0].projectId, projectId);

    const resized = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions/${id}/resize`, {
      cols: 100,
      rows: 40,
    });
    assert.equal(resized.status, 204);
    // Both dims are required at resize.
    const badResize = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions/${id}/resize`, {
      cols: 100,
    });
    assert.equal(badResize.status, 400);

    const killed = await api("DELETE", `/api/v1/projects/${projectId}/terminal-sessions/${id}`);
    assert.equal(killed.status, 204);
  });

  // Bash-arithmetic test: also self-skips on win32 (cmd.exe has no $((…)));
  // the skip must repeat the no-build guard — test-level options OVERRIDE the
  // describe-level skip, so it cannot simply say `skip: isWindows`.
  it("streams live shell output and the exit frame over SSE, then 404s after the shell exits", { timeout: 90_000, skip: isWindows || !existsSync(MAIN_JS) }, async () => {
    const projectId = await createProject("stream");
    const created = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions`, {});
    assert.equal(created.status, 201);
    const tsid = created.json.id;

    const state = await openTerminalStream(projectId, tsid);
    // The hijacked SSE response always opens with the leading comment ping.
    await waitForFirstBytes(state, T_PING_MS);
    assert.ok(state.raw.startsWith(": ping\n\n"), `stream must open with ': ping', got: ${JSON.stringify(state.raw.slice(0, 40))}`);

    // The computed marker: only REAL shell arithmetic turns the input into
    // "r46d_42" — echoing the command cannot fake it on either engine.
    const sent = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`, {
      data: "echo r46d_$((6*7))\n",
    });
    assert.equal(sent.status, 204);
    await waitForFrame(
      state,
      () => outputText(state).includes("r46d_42"),
      T_OUTPUT_MS,
      "an output frame containing r46d_42",
    );

    const exited = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`, {
      data: "exit 0\n",
    });
    assert.equal(exited.status, 204);
    const exitFrame = await waitForFrame(
      state,
      (frame) => frame.type === "exit",
      T_EXIT_MS,
      "the exit frame",
    );
    assert.equal(exitFrame.code, 0);
    // The viewer response ENDS after the exit frame (not before, not never).
    await waitForStreamEnd(state, T_END_MS);

    // A dead session is gone everywhere it used to exist.
    const listed = await api("GET", `/api/v1/projects/${projectId}/terminal-sessions`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.sessions, []);

    const input = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions/${tsid}/input`, { data: "hi\n" });
    assert.equal(input.status, 404);
    assert.equal(input.json.error.code, "NOT_FOUND");
    const stream = await fetch(`${baseUrl}/api/v1/projects/${projectId}/terminal-sessions/${tsid}/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(stream.status, 404);
    await stream.text();
    const deleted = await api("DELETE", `/api/v1/projects/${projectId}/terminal-sessions/${tsid}`);
    assert.equal(deleted.status, 404);
  });

  it("DELETE kills a live session and its viewers see the exit frame (code null)", { timeout: 60_000 }, async () => {
    const projectId = await createProject("kill");
    const created = await api("POST", `/api/v1/projects/${projectId}/terminal-sessions`, {});
    assert.equal(created.status, 201);
    const tsid = created.json.id;

    const state = await openTerminalStream(projectId, tsid);
    await waitForFirstBytes(state, T_PING_MS);
    assert.ok(state.raw.startsWith(": ping\n\n"));

    const killed = await api("DELETE", `/api/v1/projects/${projectId}/terminal-sessions/${tsid}`);
    assert.equal(killed.status, 204);

    const exitFrame = await waitForFrame(
      state,
      (frame) => frame.type === "exit",
      T_EXIT_MS,
      "the kill exit frame",
    );
    // null = killed by us (not a shell-exit status).
    assert.equal(exitFrame.code, null);
    await waitForStreamEnd(state, T_END_MS);

    const listed = await api("GET", `/api/v1/projects/${projectId}/terminal-sessions`);
    assert.deepEqual(listed.json.sessions, []);
  });

  it("404s (NOT_FOUND) for an unknown project on every terminal-session route", async () => {
    const created = await api("POST", "/api/v1/projects/prj_nope/terminal-sessions", {});
    assert.equal(created.status, 404);
    assert.equal(created.json.error.code, "NOT_FOUND");

    const listed = await api("GET", "/api/v1/projects/prj_nope/terminal-sessions");
    assert.equal(listed.status, 404);
    assert.equal(listed.json.error.code, "NOT_FOUND");
  });
});
