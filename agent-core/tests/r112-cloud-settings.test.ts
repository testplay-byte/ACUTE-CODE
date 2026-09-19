/**
 * ROUND-112 (R112-a) — the CLOUD-CONNECTOR SETTINGS surface
 * (GET/PUT /api/v1/settings/cloud-connector, storage/settings.ts's
 * cloudConnector.* rows, and the runtime apply path the PUT drives):
 *
 *   1. STORAGE — the cloudConnector.{enabled,relayUrl,hostKey} rows:
 *      default-off shape, get/set round-trip, partial patches leave the
 *      others alone, "" clears the host key, oversize rows throw.
 *   2. AUTH — the SHELL token reads/writes it; a paired DEVICE token is
 *      403 on BOTH verbs (remote access is a management-surface setting —
 *      the route-local guard + the app-level bearer-wall blocklist ride
 *      together, defense in depth).
 *   3. HOST-KEY SEMANTICS — the GET never echoes the key (hostKeyPresent
 *      only); PUT omitted = keep the saved key, "" = clear it.
 *   4. ENABLING requires the full config — relay URL, host key, and a
 *      machine identity (no dataDir → honest 400, nothing saved).
 *   5. THE RUNTIME APPLY — PUT {enabled:true} boots the tunnel through
 *      reconfigureCloudConnector (the factory sees the saved host key +
 *      the machine identity), a second PUT replaces the tunnel (the old
 *      socket gets its graceful bye), PUT {enabled:false} stops it.
 *   6. NEVER-FATAL — a throwing tunnel factory degrades to a status
 *      snapshot, never a route crash.
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
import {
  getCloudConnectorSettings,
  setCloudConnectorSettings,
} from "../src/storage/settings";
import {
  TUNNEL_BYE_TEXT,
  getCloudConnectorStatus,
  resetCloudConnectorForTest,
  setCloudConnectorFactoriesForTest,
  type TunnelSocket,
} from "../src/lib/cloud-connector";
import { deviceLinkControllerFor } from "../src/lib/device-link";

const TOKEN = "shell-token-r112cloud";
const RELAY = "https://acute-relay.example.workers.dev";
const RELAY2 = "https://other-relay.example.workers.dev";
const HOST_KEY = "host-key-r112-0123456789abcdef";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r112cloud-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir });
});

afterEach(async () => {
  // Drop the module singleton BEFORE app.close() (the graceful-close hook
  // stops the connector too — both paths are safe, this keeps tests
  // independent of each other's tunnels).
  resetCloudConnectorForTest();
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

/** Shell-token inject (the desktop window's seat — full power). */
async function shellInject(
  method: "GET" | "PUT",
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
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts?.body === undefined ? undefined : JSON.stringify(opts.body);
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
          ...(opts?.headers ?? {}),
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

/** The minimal ws-shaped fake the singleton accepts (welcome on connect). */
class MockSocket implements TunnelSocket {
  readonly sent: string[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    /* the route tests never need the close handshake */
  }

  terminate(): void {
    /* ditto */
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  receive(text: string): void {
    this.emit("message", Buffer.from(text, "utf8"));
  }
}

/** Records factory calls; every socket auto-welcomes (the connected path). */
class MockTunnel {
  readonly sockets: MockSocket[] = [];
  readonly calls: Array<{ url: string; headers: Record<string, string> }> = [];
  autoWelcome = true;

  factory = (url: string, headers: Record<string, string>): TunnelSocket => {
    this.calls.push({ url, headers });
    const socket = new MockSocket();
    this.sockets.push(socket);
    if (this.autoWelcome) {
      queueMicrotask(() => socket.receive(JSON.stringify({ t: "welcome", v: 1, machineId: "m", heartbeatMs: 25_000 })));
    }
    return socket;
  };
}

/** The machine identity the tunnel address is derived from. */
function identityOf(): { machineId: string } {
  const link = deviceLinkControllerFor(app);
  const identity = link?.identity() ?? null;
  expect(identity).not.toBeNull();
  return identity as { machineId: string };
}

/** Flush the microtask generations (the auto-welcome + stop handshakes). */
async function flush(turns = 15): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

// ── 1. storage ──────────────────────────────────────────────────────────────

describe("R112-a: cloudConnector.* storage rows", () => {
  it("defaults to disabled with empty relay URL and host key", () => {
    expect(getCloudConnectorSettings(db)).toEqual({
      enabled: false,
      relayUrl: "",
      hostKey: "",
    });
  });

  it("round-trips a full config; partial patches leave the other rows alone", () => {
    expect(setCloudConnectorSettings(db, { enabled: true, relayUrl: RELAY, hostKey: HOST_KEY })).toEqual({
      enabled: true,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    // A partial patch (the route's hostKey-keep path) writes only its own row.
    expect(setCloudConnectorSettings(db, { relayUrl: RELAY2 })).toEqual({
      enabled: true,
      relayUrl: RELAY2,
      hostKey: HOST_KEY,
    });
    expect(setCloudConnectorSettings(db, { enabled: false })).toEqual({
      enabled: false,
      relayUrl: RELAY2,
      hostKey: HOST_KEY,
    });
  });

  it("saves the relay URL trimmed; an empty string clears the host key", () => {
    expect(setCloudConnectorSettings(db, { relayUrl: `  ${RELAY}  ` }).relayUrl).toBe(RELAY);
    setCloudConnectorSettings(db, { hostKey: HOST_KEY });
    expect(setCloudConnectorSettings(db, { hostKey: "" }).hostKey).toBe("");
  });

  it("rejects oversize rows and non-boolean enabled with honest errors", () => {
    expect(() => setCloudConnectorSettings(db, { relayUrl: "h".repeat(501) })).toThrow(/relayUrl/);
    expect(() => setCloudConnectorSettings(db, { hostKey: "k".repeat(501) })).toThrow(/hostKey/);
    expect(() => setCloudConnectorSettings(db, { enabled: "yes" as unknown as boolean })).toThrow(/enabled/);
  });
});

// ── 2-4. the route: auth, key semantics, enable gating ─────────────────────

describe("R112-a: GET/PUT /api/v1/settings/cloud-connector", () => {
  it("GET answers the saved config + live status, and NEVER echoes the host key", async () => {
    setCloudConnectorSettings(db, { relayUrl: RELAY, hostKey: HOST_KEY });
    const response = await shellInject("GET", "/api/v1/settings/cloud-connector");
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toEqual({
      enabled: false,
      relayUrl: RELAY,
      hostKeyPresent: true,
      status: { state: "disabled", relayUrl: "", lastConnectedAt: null, lastError: null },
    });
    expect("hostKey" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(HOST_KEY);
  });

  it("GET/PUT sit behind the bearer wall (no token → 401)", async () => {
    const get = await app.inject({ method: "GET", url: "/api/v1/settings/cloud-connector" });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/cloud-connector",
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(401);
  });

  it("a paired DEVICE token is 403 on both verbs (management surface)", async () => {
    // Enable the link + mint + claim a real pairing (the r109 pattern).
    const enable = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
    expect(enable.statusCode).toBe(200);
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pair/start",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const qr = start.json() as { pin: string; port: number };
    const claim = await tlsRequest(qr.port, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: qr.pin },
    });
    expect(claim.status).toBe(200);
    const deviceToken = (claim.json as { deviceToken: string }).deviceToken;

    const get = await tlsRequest(qr.port, "GET", "/api/v1/settings/cloud-connector", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(get.status).toBe(403);
    expect((get.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const put = await tlsRequest(qr.port, "PUT", "/api/v1/settings/cloud-connector", {
      body: { enabled: true, relayUrl: RELAY, hostKey: HOST_KEY },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(put.status).toBe(403);
    // Nothing was applied or saved by the rejected write.
    expect(getCloudConnectorSettings(db).enabled).toBe(false);
  });

  it("PUT validates the body shape with field-naming 400s", async () => {
    const notObject = await shellInject("PUT", "/api/v1/settings/cloud-connector", {});
    expect(notObject.statusCode).toBe(200); // {} is a valid (all-keep) body

    const badEnabled = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/cloud-connector",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: [1, 2, 3],
    });
    expect(badEnabled.statusCode).toBe(400);
    expect(((badEnabled.json() as { error: { details: { field: string } } }).error).details.field).toBe("body");

    const badBoolean = await shellInject("PUT", "/api/v1/settings/cloud-connector", { enabled: "yes" });
    expect(badBoolean.statusCode).toBe(400);
    expect(((badBoolean.json() as { error: { details: { field: string } } }).error).details.field).toBe("body.enabled");

    const badUrl = await shellInject("PUT", "/api/v1/settings/cloud-connector", { relayUrl: 42 });
    expect(badUrl.statusCode).toBe(400);
    expect(((badUrl.json() as { error: { details: { field: string } } }).error).details.field).toBe("body.relayUrl");

    const oversizeKey = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      hostKey: "k".repeat(501),
    });
    expect(oversizeKey.statusCode).toBe(400);
    expect(((oversizeKey.json() as { error: { details: { field: string } } }).error).details.field).toBe(
      "body.hostKey",
    );
  });

  it("hostKey semantics: omitted = keep the saved key, empty string = clear it", async () => {
    // Save a key first (disabled — enabling is a separate concern below).
    const save = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: false,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    expect(save.statusCode).toBe(200);
    expect((save.json() as { hostKeyPresent: boolean }).hostKeyPresent).toBe(true);

    // Omitted → the saved key survives a relayUrl-only PUT.
    const keep = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      relayUrl: RELAY2,
    });
    expect(keep.statusCode).toBe(200);
    expect((keep.json() as { hostKeyPresent: boolean; relayUrl: string })).toMatchObject({
      hostKeyPresent: true,
      relayUrl: RELAY2,
    });
    expect(getCloudConnectorSettings(db).hostKey).toBe(HOST_KEY);

    // "" → cleared.
    const clear = await shellInject("PUT", "/api/v1/settings/cloud-connector", { hostKey: "" });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { hostKeyPresent: boolean }).hostKeyPresent).toBe(false);
    expect(getCloudConnectorSettings(db).hostKey).toBe("");
  });

  it("enabling requires a relay URL, then a host key, then a machine identity — nothing is saved on a 400", async () => {
    const noUrl = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      hostKey: HOST_KEY,
    });
    expect(noUrl.statusCode).toBe(400);
    expect(((noUrl.json() as { error: { details: { field: string } } }).error).details.field).toBe("body.relayUrl");

    const noKey = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY,
    });
    expect(noKey.statusCode).toBe(400);
    expect(((noKey.json() as { error: { details: { field: string } } }).error).details.field).toBe("body.hostKey");

    expect(getCloudConnectorSettings(db)).toEqual({ enabled: false, relayUrl: "", hostKey: "" });
  });

  it("enabling without a machine identity (no dataDir sidecar) is an honest 400", async () => {
    const hermeticDb = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const hermeticApp = buildServer({ token: TOKEN, db: hermeticDb });
    try {
      const response = await hermeticApp.inject({
        method: "PUT",
        url: "/api/v1/settings/cloud-connector",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { enabled: true, relayUrl: RELAY, hostKey: HOST_KEY },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION");
      expect(body.error.message).toContain("no machine identity");
      expect(getCloudConnectorSettings(hermeticDb).enabled).toBe(false);
    } finally {
      await hermeticApp.close();
      hermeticDb.close();
    }
  });
});

// ── 5-6. the runtime apply ─────────────────────────────────────────────────

describe("R112-a: the PUT's runtime apply (reconfigure/stop, never-fatal)", () => {
  let tunnel: MockTunnel;

  beforeEach(async () => {
    tunnel = new MockTunnel();
    setCloudConnectorFactoriesForTest({ createTunnelSocket: tunnel.factory });
    // The relay's room address is the LINK's machine identity, and the
    // controller loads its certificate lazily on first start() — enable the
    // link once so identity() is populated (the route's honest 400 otherwise).
    const enable = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
    expect(enable.statusCode).toBe(200);
  });

  it("PUT {enabled:true} boots the tunnel with the saved config + machine identity", async () => {
    const identity = identityOf();
    const response = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    expect(response.statusCode).toBe(200);
    // The factory saw the relay's host route with the SAVED host key and the
    // link's machine identity — the tunnel the boot block would start.
    expect(tunnel.calls).toHaveLength(1);
    expect(tunnel.calls[0]).toEqual({
      url: `${RELAY}/h/${identity.machineId}/host`,
      headers: { "x-acute-key": HOST_KEY, "x-acute-machine": identity.machineId },
    });
    // The connector connected (welcome → hello).
    await flush();
    expect(getCloudConnectorStatus().state).toBe("connected");
    expect(getCloudConnectorStatus().relayUrl).toBe(RELAY);
    expect(tunnel.sockets[0]!.sent[0]).toContain('"t":"hello"');
  });

  it("a second enabled PUT reconfigures: the OLD tunnel gets its bye, the new one connects", async () => {
    await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    await flush();
    const identity = identityOf();
    const first = tunnel.sockets[0]!;

    // hostKey omitted → the SAVED key rides the new tunnel.
    const second = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY2,
    });
    expect(second.statusCode).toBe(200);
    expect(tunnel.calls).toHaveLength(2);
    expect(tunnel.calls[1]).toEqual({
      url: `${RELAY2}/h/${identity.machineId}/host`,
      headers: { "x-acute-key": HOST_KEY, "x-acute-machine": identity.machineId },
    });
    await flush();
    // Graceful replace: the old socket got {"t":"bye"}; the new one is live.
    expect(first.sent.includes(TUNNEL_BYE_TEXT)).toBe(true);
    expect(getCloudConnectorStatus().relayUrl).toBe(RELAY2);
    expect(getCloudConnectorStatus().state).toBe("connected");
  });

  it("PUT {enabled:false} stops the tunnel (bye + disabled) and saves the flip", async () => {
    await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    await flush();
    const live = tunnel.sockets[0]!;

    const response = await shellInject("PUT", "/api/v1/settings/cloud-connector", { enabled: false });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { enabled: boolean }).enabled).toBe(false);
    await flush();
    expect(live.sent.includes(TUNNEL_BYE_TEXT)).toBe(true);
    expect(getCloudConnectorStatus()).toMatchObject({ state: "disabled" });
    // No reconnect follows a deliberate disable.
    expect(tunnel.calls).toHaveLength(1);
    // The persisted row stays off (the next boot's truth).
    expect(getCloudConnectorSettings(db)).toEqual({
      enabled: false,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
  });

  it("a THROWING tunnel factory degrades to a status snapshot — the route never crashes", async () => {
    setCloudConnectorFactoriesForTest({
      createTunnelSocket: () => {
        throw new Error("factory exploded");
      },
    });
    const response = await shellInject("PUT", "/api/v1/settings/cloud-connector", {
      enabled: true,
      relayUrl: RELAY,
      hostKey: HOST_KEY,
    });
    expect(response.statusCode).toBe(200);
    const status = (response.json() as { status: { state: string; lastError: string } }).status;
    expect(status.state).toBe("error");
    expect(status.lastError).toContain("factory exploded");
    // The sidecar stays healthy — a follow-up GET answers normally.
    const followUp = await shellInject("GET", "/api/v1/settings/cloud-connector");
    expect(followUp.statusCode).toBe(200);
    expect((followUp.json() as { enabled: boolean }).enabled).toBe(true);
  });
});
