/**
 * ROUND-122 — the SELF-FEEDBACK surfaces on the HTTP API:
 *
 *   1. THE TOGGLE (GET/PUT /api/v1/settings/feedback): default OFF, the
 *      get/set round-trip, PUT validation (400 on non-object /
 *      non-boolean), and the R113 events-bus broadcast (domain
 *      "feedback") on every PUT.
 *   2. THE LEDGER FILE (GET /api/v1/feedback/file): the honest empty
 *      state on a fresh dataDir; real content + meta after a write.
 *   3. THE CLEAR (DELETE /api/v1/feedback/file): wipes with the honest
 *      entry count; the no-file delete is the honest zero.
 *   4. AUTH SPLIT — a paired DEVICE token may VIEW the ledger (the R109
 *      view trust level) but is 403 on the CLEAR (the route-local
 *      rejectDeviceTokens guard — the path blocklist cannot split
 *      verbs on one path).
 *   5. THE OFF-STATE — no dataDir (hermetic dev server) → honest 503 on
 *      both verbs, nothing crashes.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendFeedbackEntry, readFeedbackLedger } from "../src/storage/feedback-ledger";
import { getFeedbackSettings, setFeedbackSettings } from "../src/storage/settings";
import { getEventsBus } from "../src/lib/events-bus";
// R125-B: the status registry the route reads + the clear-route reset hook
// pins — driven DIRECTLY (the writer's own begin/end reporting is pinned in
// r122-feedback-writer.test.ts; this suite pins the ROUTE's join of
// registry + setting + file).
import { beginFeedbackWrite, endFeedbackWrite } from "../src/agents/feedback-status";

const TOKEN = "shell-token-r122routes";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r122routes-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Shell-token inject (the desktop window's seat — full power). */
async function shellInject(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(payload !== undefined ? { payload } : {}),
  })) as LightMyRequestResponse;
}

/** A REAL TLS request against the device listener — the phone's seat. */
function tlsRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Enable the link, mint a pairing, claim it over TLS → the device token. */
async function pairDevice(): Promise<{ deviceToken: string; port: number }> {
  const put = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
  expect(put.statusCode).toBe(200);
  const start = await shellInject("POST", "/api/v1/mobile/pair/start");
  expect(start.statusCode).toBe(200);
  const qr = start.json() as { pin: string; port: number };
  const claim = await tlsRequest(qr.port, "POST", "/api/v1/mobile/pair/claim", { pin: qr.pin, label: "the owner's phone" });
  expect(claim.status).toBe(200);
  const claimed = claim.json as { deviceToken: string; port: number };
  return { deviceToken: claimed.deviceToken, port: qr.port };
}

/** A device-token request over the TLS listener. */
function deviceRequest(
  port: number,
  deviceToken: string,
  method: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${deviceToken}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("R122: the self-feedback settings domain (GET/PUT /settings/feedback)", () => {
  it("GET: the honest default — OFF", async () => {
    const res = await shellInject("GET", "/api/v1/settings/feedback");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
    expect(getFeedbackSettings(db)).toEqual({ enabled: false });
  });

  it("PUT round-trip + the storage row + the events-bus broadcast (domain feedback)", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const unsubscribe = getEventsBus().subscribe((frame) => {
      const f = frame as unknown as Record<string, unknown>;
      if (f.type === "settings" && f.domain === "feedback") frames.push(f);
    });
    try {
      const res = await shellInject("PUT", "/api/v1/settings/feedback", { enabled: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true });
      expect(getFeedbackSettings(db)).toEqual({ enabled: true });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ type: "settings", domain: "feedback", value: { enabled: true } });
    } finally {
      unsubscribe();
    }
  });

  it("PUT validation: a non-boolean enabled is an honest 400 (the debug domain's contract)", async () => {
    const b = await shellInject("PUT", "/api/v1/settings/feedback", { enabled: "yes" });
    expect(b.statusCode).toBe(400);
    expect((b.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    // nothing persisted
    expect(getFeedbackSettings(db)).toEqual({ enabled: false });
  });

  it("storage round-trip: setFeedbackSettings persists across reads (the debug row's sibling)", () => {
    expect(setFeedbackSettings(db, { enabled: true })).toEqual({ enabled: true });
    expect(getFeedbackSettings(db)).toEqual({ enabled: true });
    expect(setFeedbackSettings(db, {})).toEqual({ enabled: true }); // empty patch keeps
  });
});

describe("R122: the ledger file surface (GET/DELETE /feedback/file)", () => {
  it("GET on a fresh dataDir: the honest empty state (never a 404)", async () => {
    const res = await shellInject("GET", "/api/v1/feedback/file");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false, content: "", bytes: 0, updatedAt: null, entries: 0 });
  });

  it("GET after a real write: content + meta (entries, bytes, updatedAt)", async () => {
    await appendFeedbackEntry(
      dataDir,
      "## Entry — 2026-09-23T00:00:00.000Z\n\n### What I was trying to do\nThe thing.",
    );
    const res = await shellInject("GET", "/api/v1/feedback/file");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { exists: boolean; content: string; bytes: number; entries: number; updatedAt: string };
    expect(body.exists).toBe(true);
    expect(body.entries).toBe(1);
    expect(body.bytes).toBe(readFeedbackLedger(dataDir).bytes);
    expect(body.updatedAt).not.toBeNull();
    expect(body.content).toContain("## Entry — 2026-09-23T00:00:00.000Z");
    expect(body.content).toContain("### What I was trying to do");
  });

  it("DELETE wipes with the honest count; the no-file delete is the honest zero", async () => {
    const empty = await shellInject("DELETE", "/api/v1/feedback/file");
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ cleared: true, entries: 0 });
    await appendFeedbackEntry(dataDir, "## Entry — a\n\none");
    await appendFeedbackEntry(dataDir, "## Entry — b\n\ntwo");
    const res = await shellInject("DELETE", "/api/v1/feedback/file");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: true, entries: 2 });
    expect(readFeedbackLedger(dataDir).exists).toBe(false);
  });

  // ── ROUND-123 (R123): the PER-ENTRY delete ──────────────────────────────
  it("R123: DELETE /feedback/file/entry/:index removes EXACTLY one entry; the survivors stay byte-identical", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — a\n\n- **Turn outcome**: ok\n\n### What I was trying to do\nFirst.");
    await appendFeedbackEntry(dataDir, "## Entry — b\n\n- **Turn outcome**: ok\n\n### What I was trying to do\nSecond.");
    await appendFeedbackEntry(dataDir, "## Entry — c\n\n- **Turn outcome**: ok\n\n### What I was trying to do\nThird.");
    // Delete the MIDDLE entry (index 1).
    const res = await shellInject("DELETE", "/api/v1/feedback/file/entry/1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true, entries: 2 });
    const after = readFeedbackLedger(dataDir);
    expect(after.entries).toBe(2);
    expect(after.content).toContain("## Entry — a");
    expect(after.content).toContain("## Entry — c");
    expect(after.content).not.toContain("## Entry — b");
    expect(after.content).toContain("First.");
    expect(after.content).toContain("Third.");
    expect(after.content).not.toContain("Second.");
    // The file header survives untouched.
    expect(after.content.startsWith("# ACUTE-CODE")).toBe(true);
  });

  it("R123: an out-of-range index is the idempotent honest no-op (never a 404); a bad index is a 400", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — only\n\nsolo");
    const stale = await shellInject("DELETE", "/api/v1/feedback/file/entry/5");
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ removed: false, entries: 1 });
    expect(readFeedbackLedger(dataDir).entries).toBe(1);
    const negative = await shellInject("DELETE", "/api/v1/feedback/file/entry/-1");
    expect(negative.statusCode).toBe(400);
    expect((negative.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    const garbage = await shellInject("DELETE", "/api/v1/feedback/file/entry/abc");
    expect(garbage.statusCode).toBe(400);
  });

  it("R123: the AUTH SPLIT rides the entry delete too — a paired device token is 403, the ledger untouched", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — x\n\nphone cannot delete me");
    await appendFeedbackEntry(dataDir, "## Entry — y\n\nnor me");
    const { deviceToken, port } = await pairDevice();
    const attempt = await deviceRequest(port, deviceToken, "DELETE", "/api/v1/feedback/file/entry/0");
    expect(attempt.status).toBe(403);
    expect((attempt.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(readFeedbackLedger(dataDir).entries).toBe(2);
  });

  it("AUTH SPLIT: a paired device token VIEWS the ledger but is 403 on the CLEAR", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — x\n\nthe phone can read me");
    const { deviceToken, port } = await pairDevice();
    // VIEW: 200 with content (the R109 view trust level).
    const view = await deviceRequest(port, deviceToken, "GET", "/api/v1/feedback/file");
    expect(view.status).toBe(200);
    expect((view.json as { exists: boolean }).exists).toBe(true);
    expect(JSON.stringify(view.json)).toContain("the phone can read me");
    // CLEAR: 403, and the ledger is UNTOUCHED.
    const wipe = await deviceRequest(port, deviceToken, "DELETE", "/api/v1/feedback/file");
    expect(wipe.status).toBe(403);
    expect((wipe.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(readFeedbackLedger(dataDir).entries).toBe(1);
  });
});

describe("R122: the off-state (no machine-scoped dataDir)", () => {
  it("both verbs answer the honest 503 — no ledger home, no crash", async () => {
    const hermeticApp = buildServer({
      token: TOKEN,
      db: openDatabase(join(tempDir, `${randomUUID()}.db`)),
    });
    try {
      const get = await hermeticApp.inject({
        method: "GET",
        url: "/api/v1/feedback/file",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(503);
      expect((get.json() as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
      const del = await hermeticApp.inject({
        method: "DELETE",
        url: "/api/v1/feedback/file",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(503);
      // R125-B: the STATUS route joins the same off-state contract (the
      // registry alone would answer, but a status line pointing at a ledger
      // that cannot exist is not honest — 503 like its siblings).
      const status = await hermeticApp.inject({
        method: "GET",
        url: "/api/v1/feedback/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(status.statusCode).toBe(503);
      expect((status.json() as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      await hermeticApp.close();
    }
  });
});

// ── ROUND-125 (R125-B): the LIVE STATUS route ─────────────────────────────

describe("R125-B: the status surface (GET /feedback/status)", () => {
  it("the idle join: the setting OFF, nothing writing, the file's honest zero — the exact shape the strip renders", async () => {
    const res = await shellInject("GET", "/api/v1/feedback/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      writing: false,
      phase: "turn-end",
      sessionId: null,
      startedAt: null,
      lastWriteTs: null,
      lastWriteOutcome: null,
      entries: 0,
      bytes: 0,
      lastError: null,
    });
  });

  it("the LIVE join: writing state + the file's real numbers + the setting, all in ONE reply", async () => {
    setFeedbackSettings(db, { enabled: true });
    await appendFeedbackEntry(
      dataDir,
      "## Entry — 2026-09-23T00:00:00.000Z\n\n### What I was trying to do\nThe thing.",
    );
    // The registry mid-flight (what the writer's begin would have set —
    // driven directly so the route pin does not need a model call).
    const run = beginFeedbackWrite("sess_status", "mid-turn");
    const live = await shellInject("GET", "/api/v1/feedback/status");
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      enabled: true,
      writing: true,
      phase: "mid-turn",
      sessionId: "sess_status",
      startedAt: expect.any(String),
      entries: 1,
      bytes: readFeedbackLedger(dataDir).bytes,
    });
    // And after the write completes — the last-write half of the join.
    // (lastEntries lives in the REGISTRY only — the route's entry count is
    // the FILE's live number, pinned above; the registry field itself is
    // pinned in feedback-status.test.ts.)
    endFeedbackWrite(run, { ok: true, entries: 2 });
    const done = await shellInject("GET", "/api/v1/feedback/status");
    expect(done.json()).toMatchObject({
      enabled: true,
      writing: false,
      lastWriteTs: expect.any(String),
      lastWriteOutcome: "written",
      lastError: null,
      entries: 1, // the FILE's live count — one append actually happened
    });
  });

  it("the CLEAR route resets the last-write fields (the strip must not point at a deleted file)", async () => {
    const run = beginFeedbackWrite("sess_clear", "turn-end");
    endFeedbackWrite(run, { ok: true, entries: 4 });
    const before = await shellInject("GET", "/api/v1/feedback/status");
    expect((before.json() as { lastWriteOutcome: string | null }).lastWriteOutcome).toBe("written");

    const wipe = await shellInject("DELETE", "/api/v1/feedback/file");
    expect(wipe.statusCode).toBe(200);
    const after = await shellInject("GET", "/api/v1/feedback/status");
    expect(after.json()).toMatchObject({
      lastWriteTs: null,
      lastWriteOutcome: null,
      lastError: null,
      entries: 0,
      bytes: 0,
    });
  });

  it("PHONE-REACHABLE: a paired device token may VIEW the status (the R109 view trust level — no device wall on this GET)", async () => {
    await appendFeedbackEntry(dataDir, "## Entry — x\n\nthe phone can watch me being written");
    const { deviceToken, port } = await pairDevice();
    const view = await deviceRequest(port, deviceToken, "GET", "/api/v1/feedback/status");
    expect(view.status).toBe(200);
    const body = view.json as Record<string, unknown>;
    expect(body.enabled).toBe(false); // the honest current setting
    expect(body.entries).toBe(1);
    // STATUS only — the entry's words never ride the reply.
    expect(JSON.stringify(view.json)).not.toContain("the phone can watch me");
  });
});
