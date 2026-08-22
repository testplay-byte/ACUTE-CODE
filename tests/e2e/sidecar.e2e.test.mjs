// Black-box E2E against the built sidecar. Skips entirely when agent-core/dist
// is absent (e.g. `pnpm test` before a build) — `pnpm verify` runs this after build.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const MAIN_JS = join(REPO_ROOT, "agent-core", "dist", "main.js");
const TOKEN = "e2e-black-box-token";

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

async function api(method, path, body, auth = true) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
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

beforeAll(async () => {
  if (!existsSync(MAIN_JS)) return;
  tempDir = mkdtempSync(join(tmpdir(), "acute-e2e-"));
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

describe("sidecar e2e (skipped without a prior build)", { skip: !existsSync(MAIN_JS) }, () => {
  it("boots, prints the ready line, and answers /health without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.app, "acute-code");
  });

  it("enforces the bearer wall", async () => {
    const denied = await api("GET", "/api/v1/agents", undefined, false);
    assert.equal(denied.status, 401);
    assert.equal(denied.json.error.code, "UNAUTHORIZED");
  });

  it("seeds exactly the five templates on a fresh database", async () => {
    const { status, json } = await api("GET", "/api/v1/agents");
    assert.equal(status, 200);
    assert.equal(json.agents.length, 5);
    assert.deepEqual(
      json.agents.map((a) => a.name).sort(),
      ["Coder", "Planner", "Researcher", "Reviewer", "Tester"],
    );
    assert.ok(json.agents.every((a) => a.isTemplate));
  });

  it("creates, duplicates, patches, and deletes an agent", async () => {
    const created = await api("POST", "/api/v1/agents", {
      name: "E2E Bot",
      role: "tester",
      memoryPolicy: "on-start",
      allowedTools: ["file_read"],
      maxTurns: 5,
      temperature: 0.3,
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    const dup = await api("POST", `/api/v1/agents/${id}/duplicate`);
    assert.equal(dup.status, 201);
    assert.notEqual(dup.json.id, id);

    const patched = await api("PATCH", `/api/v1/agents/${id}`, { temperature: 0.7 });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.temperature, 0.7);
    assert.equal(patched.json.version, 2);

    const gone = await api("DELETE", `/api/v1/agents/${dup.json.id}`);
    assert.equal(gone.status, 204);
  });

  it("protects templates and rejects invalid input", async () => {
    const { json } = await api("GET", "/api/v1/agents");
    const template = json.agents[0];
    const del = await api("DELETE", `/api/v1/agents/${template.id}`);
    assert.equal(del.status, 409);

    const bad = await api("POST", "/api/v1/agents", {
      name: "Bad",
      memoryPolicy: "sometimes",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "VALIDATION");
  });

  it("returns 409 CONFLICT when messaging an unconfigured agent (no network)", async () => {
    const created = await api("POST", "/api/v1/agents", {
      name: "NoProvider",
      memoryPolicy: "none",
    });
    const session = await api("POST", "/api/v1/sessions", {
      agentId: created.json.id,
      mode: "single",
    });
    assert.ok([200, 201, 202].includes(session.status), `session create returned ${session.status}`);
    const turn = await api("POST", `/api/v1/sessions/${session.json.session?.id ?? session.json.id}/messages`, {
      content: "hello",
    });
    assert.equal(turn.status, 409);
    assert.equal(turn.json.error.code, "CONFLICT");
  });
});
