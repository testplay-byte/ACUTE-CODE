/**
 * ROUND-106 (R106-S1): the FCM publisher SKELETON — the graceful no-op's
 * contract. The bus fan-out gained ONE destination (publishFcm, wired in
 * buildServer next to sendPushToAll); until the owner's Firebase
 * credentials arrive with the remote-access round it must:
 *
 *   · resolve immediately (never reject, never throw) when fcm.json is
 *     ABSENT — the default state of every install;
 *   · resolve as a no-op when fcm.json is present but {enabled:false};
 *   · still resolve as an honest not-wired result when enabled:true (the
 *     sender itself lands with the credentials round);
 *   · leave the notification pipeline fully functional in all three
 *     states (the r42 web-push fan-out test stays the canonical one —
 *     this file pins the NEW leg + the bus's survival with it).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { getNotificationBus } from "../src/lib/notification-bus";
import { listNotifications } from "../src/storage/notifications";
import {
  FCM_CONFIG_FILENAME,
  loadFcmConfig,
  publishFcm,
  resetFcmConfigForTest,
} from "../src/lib/fcm-push";

const TOKEN = "r106-fcm-token-71d2";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance | undefined;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r106fcm-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  resetFcmConfigForTest();
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
  db.close();
  resetFcmConfigForTest();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows file-handle lag)
  }
});

describe("R106-S1: the FCM publisher skeleton (graceful no-op)", () => {
  it("resolves as a no-op when fcm.json is ABSENT (the default install state)", async () => {
    const result = await publishFcm(dataDir, {
      id: "n-1",
      ts: new Date().toISOString(),
      kind: "task_complete",
      title: "Task done",
      body: null,
      sessionId: null,
      projectId: null,
      read: 0,
    });
    expect(result).toMatchObject({ delivered: 0, skipped: true });
    expect(typeof result.reason).toBe("string");
  });

  it("resolves as a no-op when fcm.json is present but disabled", async () => {
    writeFileSync(join(dataDir, FCM_CONFIG_FILENAME), `${JSON.stringify({ enabled: false })}\n`);
    resetFcmConfigForTest();
    const result = await publishFcm(dataDir, {
      id: "n-2",
      ts: new Date().toISOString(),
      kind: "task_failed",
      title: "Task failed",
      body: null,
      sessionId: null,
      projectId: null,
      read: 0,
    });
    expect(result).toMatchObject({ delivered: 0, skipped: true });
    expect(result.reason).toContain("disabled");
  });

  it("resolves honestly when enabled (the sender itself lands with the credentials round)", async () => {
    writeFileSync(
      join(dataDir, FCM_CONFIG_FILENAME),
      `${JSON.stringify({ enabled: true, projectId: "proj-x" })}\n`,
    );
    resetFcmConfigForTest();
    const config = loadFcmConfig(dataDir);
    expect(config).toEqual({ enabled: true });
    const result = await publishFcm(dataDir, {
      id: "n-3",
      ts: new Date().toISOString(),
      kind: "permission_request",
      title: "Approval needed",
      body: null,
      sessionId: null,
      projectId: null,
      read: 0,
    });
    expect(result).toMatchObject({ delivered: 0, skipped: true });
    expect(result.reason).toContain("not wired");
  });

  it("loadFcmConfig: null when absent, cached per dataDir, reset hook works", () => {
    expect(loadFcmConfig(dataDir)).toBeNull();
    writeFileSync(join(dataDir, FCM_CONFIG_FILENAME), `${JSON.stringify({ enabled: true })}\n`);
    // The cached null from the first read is the honest pre-read state…
    expect(loadFcmConfig(dataDir)).toBeNull();
    // …and the reset hook re-reads (the test seam for the credentials round).
    resetFcmConfigForTest();
    expect(loadFcmConfig(dataDir)).toEqual({ enabled: true });
  });

  it("notifications still publish with fcm ABSENT — the bus fan-out survives the new leg", async () => {
    app = buildServer({ token: TOKEN, db, dataDir });
    const record = getNotificationBus().publish(db, {
      kind: "task_complete",
      title: "Done with fcm absent",
      body: "the fan-out must not break",
    });
    // Let the fan-out's async FCM leg resolve (fire-and-forget by design).
    await new Promise((resolve) => setImmediate(resolve));
    const rows = listNotifications(db, { unreadOnly: false, limit: 10 });
    expect(rows.map((r) => r.id)).toContain(record.id);
    expect(rows[0].title).toBe("Done with fcm absent");
  });

  it("notifications still publish with fcm DISABLED — same survival, config present", async () => {
    writeFileSync(join(dataDir, FCM_CONFIG_FILENAME), `${JSON.stringify({ enabled: false })}\n`);
    resetFcmConfigForTest();
    app = buildServer({ token: TOKEN, db, dataDir });
    const record = getNotificationBus().publish(db, {
      kind: "permission_request",
      title: "Approve with fcm disabled",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const rows = listNotifications(db, { unreadOnly: false, limit: 10 });
    expect(rows.map((r) => r.id)).toContain(record.id);
    // And the REST surface still serves it under the shell token.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as { notifications: Array<{ id: string }> }).notifications
        .map((n) => n.id),
    ).toContain(record.id);
  });
});
