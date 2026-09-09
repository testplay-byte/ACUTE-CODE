/**
 * ROUND-80 (R80) A3: the route-crash persistence — the owner's silent-stop
 * report's third root cause. An unexpected crash in the SSE stream route
 * itself (a bug in the queue-continuation loop, a sqlite hiccup in a
 * post-turn write, anything outside runStreamedAgentTurn's own try) previously
 * sent ONLY the live error frame (ROUND-43) — nothing was persisted, so a
 * reload showed the conversation ending at the user message with no error
 * and the session row stayed `running` until the next boot sweep (a
 * vanished failure — AGENT-MEMORY lesson #78's exact shape).
 *
 * The fix: the route's catch now best-effort persists a turn.error
 * (persistTurnError: the event log + the queued reset) and fires the honest
 * task_failed notification, both crash-guarded — the error frame stays the
 * guaranteed terminal event either way.
 *
 * This file needs a dedicated vi.mock of the runtime module (the crash is
 * injected at runStreamedAgentTurn); the rest of the runtime surface stays
 * real through importOriginal.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const runStreamedMock = vi.hoisted(() => vi.fn());
vi.mock("../src/agents/runtime.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runStreamedAgentTurn: runStreamedMock };
});

import { buildServer } from "../src/server";
import { listSessionEvents, createSession, getSession } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { listNotifications } from "../src/storage/notifications";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const TOKEN = "test-token-r80rc";
const KEY = "sk-r80-route-crash";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r80-rc-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  runStreamedMock.mockReset();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("R80-A3: the route crash persists the failure (never a vanished failure)", () => {
  it("runStreamedAgentTurn crashing inside the route → error frame + persisted turn.error + queued session + task_failed notification", async () => {
    const project = createProject(db, { name: "R80-Crash", rootPath: join(tempDir, "R80-Crash") });
    const agent = createAgent(db, {
      name: "R80 Crash Agent",
      providerId: "openrouter",
      model: "test/r80-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    runStreamedMock.mockRejectedValue(new Error("sqlite exploded in the queue continuation"));

    const app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages/stream`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ content: "hello" }),
      });
      // SSE 200 + the terminal INTERNAL_ERROR frame (the R43 guarantee).
      expect(res.statusCode).toBe(200);
      const body = res.body ?? "";
      expect(body).toContain("INTERNAL_ERROR");
      expect(body).toContain("sqlite exploded");
      // R80: the failure is now PERSISTED — the reload renders the error
      // card instead of a conversation that silently ends.
      const events = listSessionEvents(db, session.id);
      const turnError = events.find((ev) => ev.type === "turn.error");
      expect(turnError).toBeDefined();
      const payload = turnError?.payload as { code?: string; providerError?: string };
      expect(payload.code).toBe("INTERNAL_ERROR");
      expect(String(payload.providerError)).toContain("sqlite exploded");
      // The session row resets to queued (no more stuck `running` until the
      // boot sweep).
      expect(getSession(db, session.id)?.status).toBe("queued");
      // The honest task_failed notification fired (the crash handler's own
      // best-effort).
      const notifications = listNotifications(db, { unreadOnly: false, limit: 10 });
      const failed = notifications.find((n) => n.kind === "task_failed");
      expect(failed).toBeDefined();
      expect(String(failed?.body)).toContain("route crash");
    } finally {
      await app.close();
    }
  });

  it("a crash in the CATCH HANDLER itself (persistTurnError failing) still ends the stream with the error frame — never a hang", async () => {
    const project = createProject(db, { name: "R80-DoubleCrash", rootPath: join(tempDir, "R80-DoubleCrash") });
    const agent = createAgent(db, {
      name: "R80 Double Crash Agent",
      providerId: "openrouter",
      model: "test/r80-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    runStreamedMock.mockRejectedValue(new Error("primary crash"));
    // Corrupt the event log so the catch's own persistence throws (the
    // handler must swallow it and still send the terminal frame).
    db.exec("DROP TABLE session_events");

    const app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages/stream`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ content: "hello" }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body ?? "").toContain("INTERNAL_ERROR");
      expect(res.body ?? "").toContain("primary crash");
    } finally {
      await app.close();
    }
  });
});
