/**
 * ROUND-112 (R112-a) — the QR/claim/link-info RELAY FIELD: the additive
 * cloud address the pairing surfaces carry while the tunnel is connected.
 * The mobile contract (R112-b, final) these tests pin against:
 *
 *   · relay = the FULL guest URL `<relayBase>/m/<machineId>` (the phone
 *     appends the request path verbatim); slash-normalized so a trailing
 *     slash can never produce `//m/…`.
 *   · present ONLY while the cloud connector's status is "connected" —
 *     absent when disabled, connecting, or stopped.
 *   · STRICTLY ADDITIVE: the QR payload's v stays 1, every v1 field keeps
 *     its name and value, and the field simply disappears when there is
 *     no tunnel (a 0.105.0 phone ignores unknown fields; a 0.105.0
 *     DESKTOP pairing with a 0.106.0 phone must look identical).
 *   · The claim response + link-info carry the same field (the claim
 *     response WINS on the phone — the desktop just publishes it).
 *   · A relay-proxied /health (the bridge forwards into the TLS device
 *     listener) answers the desktop's {ok, version, machineId} shape the
 *     phone's ladder probes for.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer, VERSION } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  getCloudConnectorStatus,
  resetCloudConnectorForTest,
  setCloudConnectorFactoriesForTest,
  startCloudConnector,
  stopCloudConnector,
  type TunnelSocket,
} from "../src/lib/cloud-connector";
import { deviceLinkControllerFor } from "../src/lib/device-link";

const TOKEN = "shell-token-r112qr";
const RELAY = "https://acute-relay.example.workers.dev";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;
let linkPort = 0;
let machineId = "";

beforeEach(async () => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r112qr-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir });
  // The pairing surfaces need the live TLS listener (claims ride it), and
  // the machine identity loads with it.
  const enable = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
  expect(enable.statusCode).toBe(200);
  const link = deviceLinkControllerFor(app);
  const status = link?.status() ?? null;
  expect(status).not.toBeNull();
  linkPort = (status as { port: number }).port;
  machineId = (status as { machineId: string }).machineId;
  expect(machineId).toMatch(/^[0-9a-f]{64}$/);
});

afterEach(async () => {
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

/** Shell-token inject (the desktop window's seat). */
async function shellInject(
  method: "GET" | "POST" | "PUT",
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

/** The minimal ws-shaped fake (welcome → the connected tunnel state). */
class MockSocket implements TunnelSocket {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(): void {
    /* the QR tests only need the connection state, not the frames */
  }

  close(): void {
    /* ditto */
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

/** Boots the module singleton to CONNECTED (the routes read its status).
 * `rawUrl` may carry trailing slashes — the composed host route always
 * rides the NORMALIZED base (never `//h/…`). */
async function connectTunnel(rawUrl: string): Promise<void> {
  const base = rawUrl.replace(/\/+$/, "");
  setCloudConnectorFactoriesForTest({
    createTunnelSocket: (url: string, headers: Record<string, string>) => {
      expect(url).toBe(`${base}/h/${machineId}/host`);
      expect(headers).toEqual({ "x-acute-key": "k", "x-acute-machine": machineId });
      const socket = new MockSocket();
      queueMicrotask(() =>
        socket.receive(JSON.stringify({ t: "welcome", v: 1, heartbeatMs: 25_000, machineId })),
      );
      return socket;
    },
  });
  startCloudConnector({
    relayUrl: rawUrl,
    hostKey: "k",
    machineId,
    tlsPort: () => linkPort,
  });
  for (let i = 0; i < 20 && getCloudConnectorStatus().state !== "connected"; i += 1) {
    await Promise.resolve();
  }
  expect(getCloudConnectorStatus().state).toBe("connected");
}

/** pair/start → the QR payload (shell token). */
async function startPairing(): Promise<Record<string, unknown>> {
  const response = await shellInject("POST", "/api/v1/mobile/pair/start");
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

// ── 1. the relay field's presence + composition ─────────────────────────────

describe("R112-a: the QR payload's relay field", () => {
  it("carries relay = <relayBase>/m/<machineId> ONLY while connected — and nothing else changes", async () => {
    const before = await startPairing();
    expect("relay" in before).toBe(false); // no tunnel yet

    await connectTunnel(RELAY);
    const after = await startPairing();
    expect(after.relay).toBe(`${RELAY}/m/${machineId}`);

    // STRICTLY ADDITIVE: v stays 1 and every STABLE v1 field keeps its
    // name and value (addrs/port/certFP/machineId/ttl; pin + expiresAt are
    // minted per pairing session by design — the single-use rule).
    expect(after.v).toBe(1);
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before).sort(), "relay"].sort(),
    );
    for (const key of ["addrs", "port", "certFP", "machineId", "ttl", "v"]) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(before.v).toBe(1);
    expect(String(after.pin)).toMatch(/^\d{8}$/);
    expect(Array.isArray(after.addrs)).toBe(true);
  });

  it("normalizes a trailing-slash relay base before composing the guest URL", async () => {
    await connectTunnel(`${RELAY}/`);
    const qr = await startPairing();
    expect(qr.relay).toBe(`${RELAY}/m/${machineId}`);
    expect(String(qr.relay)).not.toContain("//m/");
  });

  it("disappears again once the tunnel stops (the phone's QR is LAN-only then)", async () => {
    await connectTunnel(RELAY);
    expect((await startPairing()).relay).toBeDefined();
    await stopCloudConnector();
    const qr = await startPairing();
    expect("relay" in qr).toBe(false);
    expect(getCloudConnectorStatus().state).toBe("disabled");
  });

  it("stays absent while the connector is merely CONNECTING (welcome not yet seen)", async () => {
    setCloudConnectorFactoriesForTest({
      // A socket that never welcomes — the honest mid-handshake state.
      createTunnelSocket: () => new MockSocket(),
    });
    startCloudConnector({ relayUrl: RELAY, hostKey: "k", machineId, tlsPort: () => linkPort });
    expect(getCloudConnectorStatus().state).toBe("connecting");
    const qr = await startPairing();
    expect("relay" in qr).toBe(false);
  });
});

// ── 2. the claim response + link-info ───────────────────────────────────────

describe("R112-a: the claim response + link-info carry the relay", () => {
  it("the phone's claim (real TLS hop) receives the same guest URL", async () => {
    await connectTunnel(RELAY);
    const qr = await startPairing();
    const pin = String(qr.pin);
    const claim = await tlsRequest(linkPort, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin, label: "the owner's phone" },
    });
    expect(claim.status).toBe(200);
    const claimed = claim.json as Record<string, unknown>;
    expect(claimed.relay).toBe(`${RELAY}/m/${machineId}`);
    // The claim shape's own fields stay intact (additive here too).
    expect(Object.keys(claimed).sort()).toEqual(
      ["addrs", "certFP", "deviceId", "deviceToken", "machine", "port", "relay"].sort(),
    );
    expect((claimed.machine as Record<string, unknown>).version).toBe(VERSION);
    expect(typeof claimed.deviceToken).toBe("string");
  });

  it("the claim omits relay while no tunnel is connected", async () => {
    const qr = await startPairing();
    const claim = await tlsRequest(linkPort, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: String(qr.pin) },
    });
    expect(claim.status).toBe(200);
    expect("relay" in (claim.json as Record<string, unknown>)).toBe(false);
  });

  it("link-info (the Devices tab's one-shot status) carries it while connected", async () => {
    const before = await shellInject("GET", "/api/v1/mobile/link-info");
    expect(before.statusCode).toBe(200);
    expect("relay" in (before.json() as Record<string, unknown>)).toBe(false);

    await connectTunnel(RELAY);
    const after = await shellInject("GET", "/api/v1/mobile/link-info");
    expect(after.statusCode).toBe(200);
    const info = after.json() as Record<string, unknown>;
    expect(info.relay).toBe(`${RELAY}/m/${machineId}`);
    // The v1 fields are untouched by the addition.
    expect(info.machineId).toBe(machineId);
    expect(info.enabled).toBe(true);
    expect(typeof info.port).toBe("number");
    expect(Array.isArray(info.addrs)).toBe(true);
  });
});

// ── 3. the relay-proxied /health contract (the phone's ladder probe) ────────

describe("R112-a: /health over the TLS listener (what a relay-proxied probe returns)", () => {
  it("answers the desktop's {ok, version, machineId} shape", async () => {
    // The connector's bridge forwards the phone's GET /health into the TLS
    // device listener — this is the exact response the phone's ladder
    // parses (relay-proxied = this shape, by construction).
    const probe = await tlsRequest(linkPort, "GET", "/health");
    expect(probe.status).toBe(200);
    expect(probe.json).toMatchObject({
      ok: true,
      version: VERSION,
      machineId,
    });
    expect(typeof probe.json.version).toBe("string");
    expect(String(probe.json.machineId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the loopback /health stays byte-identical to the pre-R106 contract", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", app: "acute-code", version: VERSION });
  });
});
