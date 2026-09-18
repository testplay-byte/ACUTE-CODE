/**
 * ROUND-106 (R106-S1) — the sidecar mobile-link round's regression suite:
 *
 *   1. the per-machine CERTIFICATE — generated once, persisted next to
 *      vapid.json, reused across instances (the auto-reconnect ruling's
 *      substrate: the fingerprint the phone TOFU-pinned survives restarts),
 *      the colon-hex SHA-256 fingerprint format, the machineId derivation.
 *   2. the DEVICE LISTENER — starts/stops dynamically (the settings flip,
 *      no process restart), serves REAL TLS on its own ephemeral port,
 *      routes into the ONE Fastify instance (all route groups reachable),
 *      and /health's two honest shapes (loopback plaintext unchanged,
 *      richer linkMode shape only over TLS).
 *   3. the MULTI-TOKEN WALL — a paired device token authenticates on the
 *      EXISTING route groups (real TLS requests against /agents, /sessions,
 *      /notifications — the whole /api/v1 surface rides the same wall),
 *      while the loopback inject + shell token path stays byte-identical.
 *   4. the PAIR LIFECYCLE — start → claim happy path → token works →
 *      single-use → expiry (410) → the 5-wrong-PIN ceiling → claim over
 *      plaintext rejected (403) → pair/start with a device token rejected
 *      (403) → devices list + revoke (DELETE = the token dies) →
 *      lastSeenAt throttling.
 */
import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer, startServer, VERSION } from "../src/server";
import {
  DEVICE_CERT_FILENAME,
  ensureDeviceCertificate,
  lanIPv4Addresses,
  resetDeviceCertificateForTest,
} from "../src/lib/device-cert";
import {
  generatePairingPin,
  deviceLinkControllerFor,
  PAIRING_TTL_MS,
} from "../src/lib/device-link";
import {
  createMobileDevice,
  hashDeviceToken,
  listMobileDevices,
  touchMobileDeviceLastSeen,
} from "../src/storage/mobile-devices";

const TOKEN = "r106-shell-token-9c1f";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r106-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir });
});

afterEach(async () => {
  // buildServer's own onClose hook stops the device listener (R106-S1);
  // this explicit stop is belt-and-braces for tests that killed app refs.
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows file-handle lag)
  }
});

/** Authenticated inject (the loopback plaintext path — the shell token). */
async function authInject(options: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown> | string;
  headers?: Record<string, string>;
}): Promise<LightMyRequestResponse> {
  const response = (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  })) as LightMyRequestResponse;
  return response;
}

/** A REAL TLS request against the device listener — the phone's seat.
 * rejectUnauthorized:false is the test's TOFU stand-in (the phone pins the
 * fingerprint; we trust whatever the listener presents). */
function tlsRequest(
  port: number,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
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
            /* non-JSON body — text carries it */
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The full enable flow: the settings flip returns {enabled:true} and the
 * listener is live. Returns the link-info payload (port + identity). */
async function enableLink(): Promise<Record<string, unknown> & { port: number }> {
  const put = await authInject({ method: "PUT", url: "/api/v1/settings/device-link", payload: { enabled: true } });
  expect(put.statusCode).toBe(200);
  expect(put.json()).toEqual({ enabled: true });
  const info = await authInject({ method: "GET", url: "/api/v1/mobile/link-info" });
  expect(info.statusCode).toBe(200);
  const payload = info.json() as Record<string, unknown> & { port: number };
  expect(payload.enabled).toBe(true);
  expect(typeof payload.port).toBe("number");
  return payload;
}

/** pair/start with the shell token → the QR payload. */
async function startPairing(): Promise<Record<string, unknown> & { pin: string; port: number }> {
  const response = await authInject({ method: "POST", url: "/api/v1/mobile/pair/start" });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown> & { pin: string; port: number };
}

// ── 1. the per-machine certificate ──────────────────────────────────────────

describe("R106-S1: the per-machine device certificate", () => {
  it("generates once, persists next to vapid.json, and reuses the SAME fingerprint across instances", async () => {
    const first = await ensureDeviceCertificate(dataDir);
    // The persisted file sits exactly where vapid.json lives (the same
    // directory-resolution pattern) and is mode-0600 JSON {cert, key}.
    const file = join(dataDir, DEVICE_CERT_FILENAME);
    expect(existsSync(file)).toBe(true);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { cert: string; key: string };
    expect(persisted.cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(persisted.key).toContain("-----BEGIN");

    // A "restart" (fresh in-module cache, same disk) reuses the cert — the
    // auto-reconnect ruling: the TOFU-pinned fingerprint NEVER changes.
    resetDeviceCertificateForTest();
    const second = await ensureDeviceCertificate(dataDir);
    expect(second.certFP).toBe(first.certFP);
    expect(second.machineId).toBe(first.machineId);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it("exposes the standard colon-hex SHA-256 fingerprint and the derived machineId", async () => {
    const cert = await ensureDeviceCertificate(dataDir);
    // 32 bytes → 64 hex chars, AA:BB:… colon format (Node's canonical form).
    expect(cert.certFP).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // machineId = the fingerprint, colon-free lowercase — stable per machine.
    expect(cert.machineId).toBe(cert.certFP.replace(/:/g, "").toLowerCase());
    // The fingerprint is honest: it is the SHA-256 of the DER cert.
    const x509 = new X509Certificate(cert.cert);
    expect(x509.fingerprint256).toBe(cert.certFP);
  });

  it("shapes the certificate per the contract: CN=ACUTE-CODE, RSA, ~10-year validity, generous SANs", async () => {
    const cert = await ensureDeviceCertificate(dataDir);
    const x509 = new X509Certificate(cert.cert);
    expect(x509.subject).toContain("CN=ACUTE-CODE");
    expect(x509.publicKey.asymmetricKeyType).toBe("rsa");
    // 10-year validity (±a day for test runtime) — the cert must outlive
    // any ownership horizon because rotating it forces re-pairing.
    // (validTo is the string form — "Sep 15 15:02:43 2036 GMT".)
    const years = (Date.parse(x509.validTo) - Date.now()) / (365 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);
    // SANs: loopback + localhost + this machine's LAN IPv4s.
    expect(x509.subjectAltName).toContain("DNS:localhost");
    expect(x509.subjectAltName).toContain("IP Address:127.0.0.1");
    for (const addr of lanIPv4Addresses()) {
      expect(x509.subjectAltName).toContain(`IP Address:${addr}`);
    }
  });

  it("lists the machine's non-internal IPv4 addresses (the tunnel-ready addrs array)", () => {
    const addrs = lanIPv4Addresses();
    expect(Array.isArray(addrs)).toBe(true);
    for (const addr of addrs) {
      expect(addr).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
    // The loopback face is internal and never rides the pairing payload.
    expect(addrs).not.toContain("127.0.0.1");
  });
});

// ── 2. the device listener (dual-listener architecture) ─────────────────────

describe("R106-S1: the device listener", () => {
  it("starts and stops dynamically through the settings toggle (no restart)", async () => {
    // OFF by default — link-info reports the honest off state.
    const before = await authInject({ method: "GET", url: "/api/v1/mobile/link-info" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ enabled: false, port: null, activePairing: null });

    // The toggle flips it ON: a real port exists.
    const on = await enableLink();
    expect(on.port).toBeGreaterThan(0);
    expect(Array.isArray(on.addrs)).toBe(true);
    expect(typeof on.certFP).toBe("string");
    expect(typeof on.machineId).toBe("string");

    // …and OFF again: the port closes (a connection attempt now refuses).
    const off = await authInject({ method: "PUT", url: "/api/v1/settings/device-link", payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const info = await authInject({ method: "GET", url: "/api/v1/mobile/link-info" });
    expect(info.json()).toMatchObject({ enabled: false, port: null, activePairing: null });
    await expect(tlsRequest(on.port, "GET", "/health")).rejects.toThrow();
  });

  it("serves REAL TLS on its own ephemeral port and routes into the ONE Fastify instance", async () => {
    const on = await enableLink();
    // /health over TLS answers the phone's probe shape.
    const health = await tlsRequest(on.port, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({
      ok: true,
      version: expect.any(String),
      machineId: on.machineId,
      linkMode: true,
    });

    // The SAME app's API surface answers over TLS with the shell token —
    // the dual-listener contract: ALL routes + in-memory state are shared.
    const agents = await tlsRequest(on.port, "GET", "/api/v1/agents", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(agents.status).toBe(200);
    expect(Array.isArray((agents.json as { agents: unknown[] }).agents)).toBe(true);
  });

  it("keeps the loopback /health shape byte-identical while the link is ON", async () => {
    await enableLink();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", app: "acute-code", version: VERSION });
  });
});

// ── 3. the multi-token wall ─────────────────────────────────────────────────

describe("R106-S1: the multi-token bearer wall", () => {
  async function pairDevice(): Promise<{ token: string; id: string; port: number }> {
    const on = await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: qr.pin, label: "Wall test phone" },
    });
    expect(claim.status).toBe(200);
    const body = claim.json as { deviceToken: string; deviceId: string };
    return { token: body.deviceToken, id: body.deviceId, port: on.port };
  }

  it("accepts a device token on the EXISTING route groups (real TLS requests)", async () => {
    const device = await pairDevice();
    const auth = { authorization: `Bearer ${device.token}` };
    // Representatives of the existing surface: agents, sessions, notifications.
    const agents = await tlsRequest(device.port, "GET", "/api/v1/agents", { headers: auth });
    expect(agents.status).toBe(200);
    const sessions = await tlsRequest(device.port, "GET", "/api/v1/sessions", { headers: auth });
    expect(sessions.status).toBe(200);
    const notifications = await tlsRequest(device.port, "GET", "/api/v1/notifications", { headers: auth });
    expect(notifications.status).toBe(200);
    // …and over the loopback plaintext listener too (tokens are
    // transport-agnostic — the wall hashes the token, never the address).
    const loopback = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      headers: auth,
    });
    expect(loopback.statusCode).toBe(200);
  });

  it("keeps the shell-token loopback path and the 401s byte-identical (links off, nothing paired)", async () => {
    // Shell token still works (inject = the loopback plaintext listener).
    const okay = await authInject({ method: "GET", url: "/api/v1/agents" });
    expect(okay.statusCode).toBe(200);
    // Wrong token → the same 401 envelope as before the round.
    const wrong = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
    // An unpaired random device-token-shaped string → same 401 (the hash
    // lookup finds nothing; behavior identical to the pre-R106 wall).
    const ghost = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      headers: { authorization: `Bearer ${"a".repeat(64)}` },
    });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
  });

  it("rejects a REVOKED device token on its next request", async () => {
    const device = await pairDevice();
    const revoke = await authInject({ method: "DELETE", url: `/api/v1/mobile/devices/${device.id}` });
    expect(revoke.statusCode).toBe(200);
    const after = await tlsRequest(device.port, "GET", "/api/v1/agents", {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(after.status).toBe(401);
    expect((after.json as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });
});

// ── 4. the pair lifecycle ────────────────────────────────────────────────────

describe("R106-S1: the pairing lifecycle", () => {
  it("walks the happy path: start → claim over TLS → the minted token works everywhere", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    // The QR payload's full shape (the frontend encodes exactly this).
    expect(qr).toMatchObject({
      v: 1,
      port: on.port,
      certFP: on.certFP,
      machineId: on.machineId,
      ttl: PAIRING_TTL_MS,
    });
    expect(Array.isArray(qr.addrs)).toBe(true);
    expect(qr.pin).toMatch(/^\d{8}$/);
    expect(typeof qr.expiresAt).toBe("number");

    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: qr.pin },
    });
    expect(claim.status).toBe(200);
    const body = claim.json as {
      deviceToken: string;
      deviceId: string;
      machine: { name: string; version: string };
      certFP: string;
      port: number;
      addrs: string[];
    };
    // 32 random bytes, hex — the long-lived secret (no expiry by default).
    expect(body.deviceToken).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.deviceId).toBe("string");
    expect(body.machine.name).toEqual(expect.any(String));
    expect(body.machine.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.certFP).toBe(on.certFP);
    expect(body.port).toBe(on.port);
    expect(Array.isArray(body.addrs)).toBe(true);

    // The minted token authenticates immediately — and the default label
    // ('Android device') + scopes landed in the devices list.
    const auth = { authorization: `Bearer ${body.deviceToken}` };
    const agents = await tlsRequest(on.port, "GET", "/api/v1/agents", { headers: auth });
    expect(agents.status).toBe(200);
    const devices = await authInject({ method: "GET", url: "/api/v1/mobile/devices" });
    expect(devices.statusCode).toBe(200);
    expect(devices.json()).toEqual({
      devices: [
        expect.objectContaining({
          id: body.deviceId,
          label: "Android device",
          scopes: ["view-input"],
        }),
      ],
    });
  });

  it("honors a custom label (trimmed + capped)", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: qr.pin, label: "  Pixel 9 Pro  " },
    });
    expect(claim.status).toBe(200);
    const devices = await authInject({ method: "GET", url: "/api/v1/mobile/devices" });
    expect((devices.json() as { devices: Array<{ label: string }> }).devices[0].label).toBe("Pixel 9 Pro");
  });

  it("is single-use: a second claim with the same PIN gets 410", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const first = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(first.status).toBe(200);
    const second = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(second.status).toBe(410);
    expect((second.json as { error: { code: string } }).error.code).toBe("GONE");
  });

  it("expires after the 120-second TTL (controller-level: lazy expiry)", async () => {
    // The pairing session state is per-server in-memory; driving its clock
    // directly (only Date is faked — sockets stay real) proves the lazy
    // expiry + the 410 mapping without a two-minute test.
    const link = deviceLinkControllerFor(app);
    expect(link).not.toBeNull();
    await link!.start();
    const pairing = link!.beginPairing();
    expect(pairing).not.toBeNull();
    expect(link!.activePairing()?.pin).toBe(pairing!.pin);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(pairing!.expiresAt + 1);
      expect(link!.activePairing()).toBeNull();
      expect(link!.attemptClaim(pairing!.pin)).toEqual({ result: "gone" });
    } finally {
      vi.useRealTimers();
    }
    // …and the route answers 410 for the expired session (the same gone
    // fact, read through the HTTP surface).
    const claim = await tlsRequest(link!.status().port!, "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: pairing!.pin },
    });
    expect(claim.status).toBe(410);
  });

  it("enforces the 5-wrong-PIN brute-force ceiling, then 410s", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const wrongPin = qr.pin === "00000000" ? "00000001" : "00000000";
    for (let attempt = 4; attempt >= 1; attempt -= 1) {
      const response = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: wrongPin } });
      expect(response.status).toBe(401);
      expect((response.json as { error: { code: string; details: { attemptsRemaining: number } } }).error.code).toBe("UNAUTHORIZED");
      expect((response.json as { error: { details: { attemptsRemaining: number } } }).error.details.attemptsRemaining).toBe(attempt);
    }
    // The 5th wrong attempt kills the session (attemptsRemaining hits 0).
    const fifth = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: wrongPin } });
    expect(fifth.status).toBe(401);
    expect((fifth.json as { error: { details: { attemptsRemaining: number; note?: string } } }).error.details.attemptsRemaining).toBe(0);
    expect((fifth.json as { error: { details: { note?: string } } }).error.details.note).toContain("invalidated");
    // The session is gone entirely — even the CORRECT pin now 410s.
    const correct = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(correct.status).toBe(410);
  });

  it("rejects a claim that did not ride the TLS listener (403 before any session state)", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    // inject() = the loopback plaintext listener's world (no TLS socket).
    const plaintext = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pair/claim",
      payload: { pin: qr.pin },
    });
    expect(plaintext.statusCode).toBe(403);
    expect((plaintext.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    // The session was NOT consumed by the rejected plaintext claim — over
    // TLS the same PIN still claims (the gate is about the TRANSPORT, and
    // it fired before any session state was touched).
    const tls = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(tls.status).toBe(200);
    // And a claim over TLS with NO live session is the honest 410.
    const noSession = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(noSession.status).toBe(410);
  });

  it("rejects pair/start driven by a DEVICE token (403 — pairing is a desktop-side action)", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(claim.status).toBe(200);
    const deviceToken = (claim.json as { deviceToken: string }).deviceToken;
    for (const [method, url] of [
      ["POST", "/api/v1/mobile/pair/start"],
      ["GET", "/api/v1/mobile/devices"],
      ["GET", "/api/v1/mobile/link-info"],
    ] as const) {
      const response = await app.inject({ method, url, headers: { authorization: `Bearer ${deviceToken}` } });
      expect(response.statusCode).toBe(403);
      expect((response.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }
    // …and revoke is shell-only too.
    const deviceId = (claim.json as { deviceId: string }).deviceId;
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/mobile/devices/${deviceId}`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(revoke.statusCode).toBe(403);
  });

  it("pair/start with no active link is the honest 503 (enable first)", async () => {
    const response = await authInject({ method: "POST", url: "/api/v1/mobile/pair/start" });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe("UNAVAILABLE");
  });

  it("pair/start invalidates any prior active session (ONE active pairing)", async () => {
    const on = await enableLink();
    const first = await startPairing();
    const second = await startPairing();
    expect(second.pin).not.toBe(first.pin);
    // The FIRST pin no longer claims; the second does.
    const stale = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: first.pin } });
    expect(stale.status).toBe(401);
    const fresh = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: second.pin } });
    expect(fresh.status).toBe(200);
  });
});

// ── 5. devices list / revoke / lastSeenAt ───────────────────────────────────

describe("R106-S1: the linked-devices list, revocation, and lastSeenAt", () => {
  it("lists paired devices with the contract shape and 404s unknown revocations", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin, label: "Phone A" } });
    expect(claim.status).toBe(200);
    const deviceId = (claim.json as { deviceId: string }).deviceId;

    const devices = await authInject({ method: "GET", url: "/api/v1/mobile/devices" });
    expect(devices.statusCode).toBe(200);
    const rows = (devices.json() as { devices: Array<Record<string, unknown>> }).devices;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: deviceId, label: "Phone A", scopes: ["view-input"] });
    expect(typeof rows[0].createdAt).toBe("number");
    expect(typeof rows[0].lastSeenAt).toBe("number");

    // Revoke → {ok:true}; a second revoke of the same id is the honest 404.
    const revoke = await authInject({ method: "DELETE", url: `/api/v1/mobile/devices/${deviceId}` });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true, revoked: deviceId });
    const again = await authInject({ method: "DELETE", url: `/api/v1/mobile/devices/${deviceId}` });
    expect(again.statusCode).toBe(404);
    const empty = await authInject({ method: "GET", url: "/api/v1/mobile/devices" });
    expect((empty.json() as { devices: unknown[] }).devices).toHaveLength(0);
  });

  it("throttles lastSeenAt writes (≥60s between writes per device)", () => {
    // Storage-level pin of the wall's throttle: a chatty phone must not
    // turn every request into a write, but a quiet minute must refresh.
    const deviceId = randomUUID();
    const created = createMobileDevice(db, { id: deviceId, label: "Throttle phone", tokenHash: hashDeviceToken("t-1") });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(created.createdAt + 1_000); // 1s later — throttled
      expect(touchMobileDeviceLastSeen(db, deviceId)).toBe(false);
      expect(listMobileDevices(db)[0].lastSeenAt).toBe(created.lastSeenAt);
      vi.setSystemTime(created.createdAt + 61_000); // 61s later — writes
      expect(touchMobileDeviceLastSeen(db, deviceId)).toBe(true);
      expect(listMobileDevices(db)[0].lastSeenAt).toBe(created.createdAt + 61_000);
      // Unknown device → false, never throws.
      expect(touchMobileDeviceLastSeen(db, "nope")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the wall refreshes lastSeenAt for device-token requests (visible in the list)", async () => {
    const on = await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest(on.port, "POST", "/api/v1/mobile/pair/claim", { body: { pin: qr.pin } });
    expect(claim.status).toBe(200);
    const { deviceToken, deviceId } = claim.json as { deviceToken: string; deviceId: string };

    // A request 1s after pairing: throttled (lastSeenAt == createdAt).
    await tlsRequest(on.port, "GET", "/api/v1/agents", { headers: { authorization: `Bearer ${deviceToken}` } });
    let rows = (await authInject({ method: "GET", url: "/api/v1/mobile/devices" })).json() as {
      devices: Array<{ createdAt: number; lastSeenAt: number }>;
    };
    expect(rows.devices[0].lastSeenAt).toBe(rows.devices[0].createdAt);

    // 61s later (only the CLOCK is faked — sockets stay real) the next
    // device-token request writes the fresh stamp.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await tlsRequest(on.port, "GET", "/api/v1/agents", { headers: { authorization: `Bearer ${deviceToken}` } });
      rows = (await authInject({ method: "GET", url: "/api/v1/mobile/devices" })).json() as {
        devices: Array<{ createdAt: number; lastSeenAt: number }>;
      };
      expect(rows.devices[0].lastSeenAt).toBeGreaterThan(rows.devices[0].createdAt);
      expect(listMobileDevices(db).map((d) => d.id)).toContain(deviceId);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 6. the pairing PIN's randomness (no modulo bias) ────────────────────────

describe("R106-S1: the pairing PIN", () => {
  it("mints 8-digit numeric PINs (rejection sampling, leading zeros preserved)", () => {
    const pins = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const pin = generatePairingPin();
      expect(pin).toMatch(/^\d{8}$/);
      pins.add(pin);
    }
    // 200 draws from a 10^8 space: collisions are possible but rare —
    // ≥150 distinct pins is a healthy spread (a biased generator would
    // collapse into a small cluster).
    expect(pins.size).toBeGreaterThanOrEqual(150);
  });
});

// ── 7. the startServer boot (persisted setting + ACUTE_HOST) ────────────────

describe("R106-S1: the startServer boot", () => {
  /** A real startServer run in a scratch dir; the caller closes it. */
  async function boot(opts?: { acuteHost?: string }): Promise<{
    close: () => Promise<void>;
    inject: (method: "GET" | "PUT" | "POST" | "DELETE", url: string) => Promise<LightMyRequestResponse>;
    readyLine: string;
    logCalls: string[];
  }> {
    const dbDir = mkdtempSync(join(tempDir, "boot-"));
    const prev = process.env.ACUTE_HOST;
    if (opts?.acuteHost === undefined) delete process.env.ACUTE_HOST;
    else process.env.ACUTE_HOST = opts.acuteHost;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const running = await startServer({ token: TOKEN, dbPath: join(dbDir, "acute.db") });
      return {
        close: async () => {
          await running.server.close();
          if (prev === undefined) delete process.env.ACUTE_HOST;
          else process.env.ACUTE_HOST = prev;
          log.mockRestore();
        },
        inject: (method, url) =>
          running.server.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } }) as Promise<LightMyRequestResponse>,
        readyLine: String(log.mock.calls[0]?.[0] ?? ""),
        logCalls: log.mock.calls.map((call) => String(call[0] ?? "")),
      };
    } catch (err) {
      if (prev === undefined) delete process.env.ACUTE_HOST;
      else process.env.ACUTE_HOST = prev;
      log.mockRestore();
      throw err;
    }
  }

  it("force-enables the device link when ACUTE_HOST is non-loopback (and persists it)", async () => {
    const server = await boot({ acuteHost: "0.0.0.0" });
    try {
      // The ready line stays FIRST and port-only (the shell's contract —
      // the structured boot log for the link may follow, never precede).
      expect(server.readyLine).toMatch(/^ACUTE_READY \{"port":\d+\}$/);
      expect(server.readyLine).not.toContain(TOKEN);
      // The listener is live and the setting PERSISTED (a later boot with
      // no env reads the same truth).
      const linkInfo = await server.inject("GET", "/api/v1/mobile/link-info");
      expect(linkInfo.statusCode).toBe(200);
      const info = linkInfo.json() as { enabled: boolean; port: number | null; certFP: string | null };
      expect(info.enabled).toBe(true);
      expect(typeof info.port).toBe("number");
      expect(info.certFP).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      const setting = await server.inject("GET", "/api/v1/settings/device-link");
      expect(setting.json()).toEqual({ enabled: true });
      // The phone's health probe answers over the real TLS listener.
      const health = await tlsRequest(info.port!, "GET", "/health");
      expect(health.status).toBe(200);
      expect(health.json).toMatchObject({ ok: true, linkMode: true });
    } finally {
      await server.close();
    }
  });

  it("stays loopback-only by default (fresh db, no env: link off, exactly ONE ready line)", async () => {
    const server = await boot();
    try {
      // The pre-R106 boot contract byte-identical: one ready line, port only.
      expect(server.logCalls).toHaveLength(1);
      expect(server.logCalls[0]).toMatch(/^ACUTE_READY \{"port":\d+\}$/);
      expect(server.logCalls[0]).not.toContain(TOKEN);
      // The link is OFF — pair/start says so honestly.
      const setting = await server.inject("GET", "/api/v1/settings/device-link");
      expect(setting.json()).toEqual({ enabled: false });
      const pairStart = await server.inject("POST", "/api/v1/mobile/pair/start");
      expect(pairStart.statusCode).toBe(503);
    } finally {
      await server.close();
    }
  });
});
