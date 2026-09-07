/**
 * ROUND-42 regression tests — the owner's four backend-facing fixes:
 *
 *  1. Auto-rename: sessions created by the sidebar's + button are seeded
 *     `New chat · <ProjectName>`; maybeAutoTitleSession must treat that as a
 *     DEFAULT title (R41 only matched `null` / the bare project name — the
 *     owner reported sessions "still not renamed").
 *  2. Web Push surface: GET /notifications/push/key (503 without a dataDir,
 *     200 with one), POST subscribe (validation + upsert), POST unsubscribe.
 *     The bus fans every publish out to every subscription (web-push mocked —
 *     hermetic, no network).
 *  3. POST /sessions/:id/stop — the explicit Stop path (turns now survive
 *     client disconnects; Stop must abort server-side).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// web-push mocked at the module boundary — no network, deterministic keys.
const sendNotificationMock = vi.hoisted(() => vi.fn());
const generateVapidKeysMock = vi.hoisted(() => vi.fn());
vi.mock("web-push", () => ({
  default: {
    sendNotification: sendNotificationMock,
    generateVAPIDKeys: generateVapidKeysMock,
  },
}));

import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import {
  appendSessionEvent,
  createSession,
  listSessionEvents,
  maybeAutoTitleSession,
} from "../src/storage/sessions";
import { createProject } from "../src/storage/projects";
import { getNotificationBus } from "../src/lib/notification-bus";
import { resetVapidKeysForTest } from "../src/lib/web-push";
import { Orchestrator } from "../src/agents/orchestrator";
import { setSessionStatus } from "../src/storage/sessions";

const TOKEN = "test-token-r42";
const KEY = "sk-or-vtest-77f2";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r42-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  sendNotificationMock.mockReset();
  sendNotificationMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined as unknown as FastifyInstance;
  }
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

async function build(opts?: { withDataDir?: boolean }): Promise<FastifyInstance> {
  return buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    ...(opts?.withDataDir ? { dataDir } : {}),
  });
}

async function authInject(options: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

// ── 1. Auto-rename recognizes the sidebar's `New chat · <Project>` seed ────

describe("maybeAutoTitleSession (ROUND-42 fix)", () => {
  it("renames a session seeded `New chat · <ProjectName>` (the sidebar's + button path)", () => {
    const project = createProject(db, { name: "P1", rootPath: "C:\\work\\P1" });
    const session = createSession(db, {
      agentId: "agt_tpl_coder",
      mode: "single",
      projectId: project.id,
      title: `New chat · ${project.name}`,
    });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      payload: { role: "user", content: "please add a login page with a nice form and validation" },
    });

    maybeAutoTitleSession(db, session.id);

    const title = (db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(session.id) as { title: string | null }).title;
    expect(title).toBe("Please add a login page with a nice form and validation");
  });

  it("still renames null-titled sessions (the chat panel's auto-create path)", () => {
    const project = createProject(db, { name: "WebApp", rootPath: "/srv/webapp" });
    const session = createSession(db, {
      agentId: "agt_tpl_coder",
      mode: "single",
      projectId: project.id,
      title: null,
    });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      payload: { role: "user", content: "fix the failing build" },
    });

    maybeAutoTitleSession(db, session.id);
    const title = (db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(session.id) as { title: string | null }).title;
    expect(title).toBe("Fix the failing build");
  });

  it("does NOT rename once the user has manually titled the session", () => {
    const project = createProject(db, { name: "Api", rootPath: "/srv/api" });
    const session = createSession(db, {
      agentId: "agt_tpl_coder",
      mode: "single",
      projectId: project.id,
      title: "My custom name",
    });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      payload: { role: "user", content: "whatever the first message says" },
    });

    maybeAutoTitleSession(db, session.id);
    const title = (db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(session.id) as { title: string | null }).title;
    expect(title).toBe("My custom name");
  });

  it("does not rename again after the first auto-title has landed", () => {
    const project = createProject(db, { name: "P2", rootPath: "C:\\work\\P2" });
    const session = createSession(db, {
      agentId: "agt_tpl_coder",
      mode: "single",
      projectId: project.id,
      title: `New chat · ${project.name}`,
    });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      payload: { role: "user", content: "first message about taxes" },
    });
    maybeAutoTitleSession(db, session.id);
    const first = (db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(session.id) as { title: string | null }).title;
    expect(first).toBe("First message about taxes");

    // A second turn with a different message must NOT re-rename.
    appendSessionEvent(db, session.id, {
      type: "message.user",
      payload: { role: "user", content: "second message about invoices" },
    });
    maybeAutoTitleSession(db, session.id);
    const second = (db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(session.id) as { title: string | null }).title;
    expect(second).toBe("First message about taxes");
  });
});

// ── 2. Web Push surface ─────────────────────────────────────────────────────

describe("Web Push endpoints (ROUND-42)", () => {
  it("GET /notifications/push/key → 503 when the sidecar has no dataDir", async () => {
    resetVapidKeysForTest();
    app = await build();
    const res = await authInject({ method: "GET", url: "/api/v1/notifications/push/key" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UNAVAILABLE");
  });

  it("GET /notifications/push/key → 200 with the VAPID public key once configured", async () => {
    resetVapidKeysForTest();
    generateVapidKeysMock.mockReturnValue({ publicKey: "B-public-key-r42", privateKey: "private" });
    app = await build({ withDataDir: true });

    const res = await authInject({ method: "GET", url: "/api/v1/notifications/push/key" });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe("B-public-key-r42");
    // The keypair persisted next to the DB (machine identity).
    expect(existsSync(join(dataDir, "vapid.json"))).toBe(true);
  });

  it("POST subscribe saves a subscription; invalid bodies are rejected", async () => {
    resetVapidKeysForTest();
    generateVapidKeysMock.mockReturnValue({ publicKey: "B-pub", privateKey: "priv" });
    app = await build({ withDataDir: true });

    const bad = await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/subscribe",
      payload: { endpoint: "https://push.example.invalid/sub/1" },
    });
    expect(bad.statusCode).toBe(400);

    const good = await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/subscribe",
      payload: {
        endpoint: "https://push.example.invalid/sub/1",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      },
    });
    expect(good.statusCode).toBe(200);
    const rows = db
      .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
      .all() as Array<{ endpoint: string; p256dh: string; auth: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe("https://push.example.invalid/sub/1");

    // Upsert: re-subscribing replaces keys instead of duplicating rows.
    await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/subscribe",
      payload: {
        endpoint: "https://push.example.invalid/sub/1",
        keys: { p256dh: "rotated", auth: "rotated-auth" },
      },
    });
    const after = db
      .prepare("SELECT endpoint, p256dh FROM push_subscriptions")
      .all() as Array<{ endpoint: string; p256dh: string }>;
    expect(after).toHaveLength(1);
    expect(after[0].p256dh).toBe("rotated");
  });

  it("POST unsubscribe removes the subscription", async () => {
    resetVapidKeysForTest();
    generateVapidKeysMock.mockReturnValue({ publicKey: "B-pub", privateKey: "priv" });
    app = await build({ withDataDir: true });
    await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/subscribe",
      payload: {
        endpoint: "https://push.example.invalid/sub/2",
        keys: { p256dh: "k", auth: "a" },
      },
    });
    const res = await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/unsubscribe",
      payload: { endpoint: "https://push.example.invalid/sub/2" },
    });
    expect(res.statusCode).toBe(200);
    const count = (db
      .prepare("SELECT COUNT(*) AS c FROM push_subscriptions")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("the bus fans each published notification out to every subscription", async () => {
    resetVapidKeysForTest();
    generateVapidKeysMock.mockReturnValue({ publicKey: "B-pub", privateKey: "priv" });
    app = await build({ withDataDir: true });
    const endpoint = "https://push.example.invalid/sub/3";
    await authInject({
      method: "POST",
      url: "/api/v1/notifications/push/subscribe",
      payload: { endpoint, keys: { p256dh: "k", auth: "a" } },
    });
    sendNotificationMock.mockClear();

    getNotificationBus().publish(db, {
      kind: "task_complete",
      title: "Task complete",
      body: "done",
      sessionId: "sess_x",
      projectId: "proj_y",
    });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [subArg, payloadArg, optionsArg] = sendNotificationMock.mock.calls[0] as [
      { endpoint: string },
      string,
      { vapidDetails: { publicKey: string } },
    ];
    expect(subArg.endpoint).toBe(endpoint);
    const payload = JSON.parse(payloadArg) as { id: string; title: string; kind: string };
    expect(payload.title).toBe("Task complete");
    expect(payload.kind).toBe("task_complete");
    expect(optionsArg.vapidDetails.publicKey).toBe("B-pub");
    expect(typeof payload.id).toBe("string");
  });
});

// ── 3. Explicit stop endpoint ───────────────────────────────────────────────

describe("POST /sessions/:id/stop (ROUND-42)", () => {
  it("answers ok with stopped:false when no turn is live for the session", async () => {
    app = await build();
    const res = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_nonexistent/stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stopped: false });
  });
});

// ── 4. Boot sweep keeps idle conversations alive ────────────────────────────

describe("Orchestrator.sweepStaleRunning (ROUND-42 fix)", () => {
  it("returns idle-after-reply sessions to queued (restart no longer kills conversations)", () => {
    // Session A: finished a turn earlier — last event is an assistant reply.
    const sessionA = createSession(db, { agentId: "agt_tpl_coder", mode: "single" });
    appendSessionEvent(db, sessionA.id, {
      type: "message.user",
      payload: { role: "user", content: "hello" },
    });
    appendSessionEvent(db, sessionA.id, {
      type: "message.assistant",
      payload: { role: "assistant", content: "hi there" },
    });
    setSessionStatus(db, sessionA.id, "running");

    // Session B: crashed mid-turn — last event is a tool call, no reply.
    const sessionB = createSession(db, { agentId: "agt_tpl_coder", mode: "single" });
    appendSessionEvent(db, sessionB.id, {
      type: "message.user",
      payload: { role: "user", content: "do the thing" },
    });
    appendSessionEvent(db, sessionB.id, {
      type: "tool.use",
      payload: { role: "tool", toolName: "read_file", argsSummary: "path: x.ts", ok: null },
    });
    setSessionStatus(db, sessionB.id, "running");

    const swept = Orchestrator.sweepStaleRunning(db);
    expect(swept).toBe(1); // only the genuine mid-turn crash
    const statuses = db
      .prepare("SELECT id, status FROM sessions")
      .all() as Array<{ id: string; status: string }>;
    const byId = new Map(statuses.map((s) => [s.id, s.status]));
    expect(byId.get(sessionA.id)).toBe("queued"); // alive — accepts messages
    // ROUND-75 (R75): the crashed session ALSO lands in `queued` — the
    // pre-R75 terminal `failed` 409'd the next send ("session is failed and
    // no longer accepts messages") and left NOTHING in the timeline (the
    // owner's "it just outright stops there" report). Now the sweep writes
    // the honest INTERRUPTION event and keeps the session retryable.
    expect(byId.get(sessionB.id)).toBe("queued");
    const eventsB = listSessionEvents(db, sessionB.id);
    expect(eventsB.map((e) => e.type)).toEqual(["message.user", "tool.use", "turn.error"]);
    const errorPayload = eventsB[2].payload as Record<string, unknown>;
    expect(errorPayload.code).toBe("INTERRUPTED");
    expect(String(errorPayload.message)).toContain("app restarted");
    expect(errorPayload.userSeq).toBe(eventsB[0].seq); // the interrupted turn's user message
  });
});
