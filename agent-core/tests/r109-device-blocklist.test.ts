/**
 * r109-device-blocklist.test.ts — the device-token ROUTE BLOCKLIST (R109's
 * wall hardening, the trust-model pair to the phone's new management
 * surface): a paired device token authenticates against the ordinary API
 * (providers/models/agents/prompts/settings/usage — the phone's config
 * rights) but can NEVER reach:
 *
 *   · POST /api/v1/providers/:id/keys/reveal (raw key values)
 *   · POST /api/v1/system/reset (the full app wipe)
 *   · /api/v1/internal/* (the window-only dialogs + key routes)
 *   · /api/v1/computer-use/* (machine control)
 *   · the terminal families under /api/v1/projects/:id/terminal*
 *
 * The SHELL token keeps full power on every one of those routes, and the
 * 403 shape rides the standard error envelope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const TOKEN = "shell-token-for-test";

let app: FastifyInstance;
let db: SqliteDatabase;
const tempDir: string = mkdtempSync(join(tmpdir(), "acute-r109-"));
const dataDir = tempDir;

beforeEach(() => {
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
    // best-effort (Windows file-handle lag)
  }
});

/** Shell-token inject (the desktop window's seat — full power). */
async function shellInject(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts?.body === undefined ? undefined : JSON.stringify(opts?.body);
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

/** Enable the link, mint a pairing, claim it over TLS → the device token. */
async function pairDevice(): Promise<{ deviceToken: string; port: number }> {
  const put = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
  expect(put.statusCode).toBe(200);
  const start = await shellInject("POST", "/api/v1/mobile/pair/start");
  expect(start.statusCode).toBe(200);
  const qr = start.json() as { pin: string; port: number };
  const claim = await tlsRequest(qr.port, "POST", "/api/v1/mobile/pair/claim", {
    body: { pin: qr.pin, label: "the owner's phone" },
  });
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
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return tlsRequest(port, method, path, {
    body,
    headers: { authorization: `Bearer ${deviceToken}` },
  });
}

describe("R109: the device-token route blocklist", () => {
  it("the device token still speaks the ordinary API (the phone's config rights)", async () => {
    const { deviceToken, port } = await pairDevice();
    const providers = await deviceRequest(port, deviceToken, "GET", "/api/v1/providers");
    expect(providers.status).toBe(200);
    expect(Array.isArray((providers.json as { providers: unknown[] }).providers)).toBe(true);

    const agents = await deviceRequest(port, deviceToken, "GET", "/api/v1/agents");
    expect(agents.status).toBe(200);

    const usage = await deviceRequest(port, deviceToken, "GET", "/api/v1/usage/summary?days=7");
    expect(usage.status).toBe(200);

    const sessions = await deviceRequest(port, deviceToken, "GET", "/api/v1/sessions?limit=5");
    expect(sessions.status).toBe(200);

    const settings = await deviceRequest(port, deviceToken, "GET", "/api/v1/settings/retry");
    expect(settings.status).toBe(200);
  });

  it("the device token can WRITE config (PATCH a provider) but never reveal keys", async () => {
    const { deviceToken, port } = await pairDevice();
    // A provider to touch (the registry's built-in keyless row).
    const list = await deviceRequest(port, deviceToken, "GET", "/api/v1/providers");
    const providers = (list.json as { providers: { id: string }[] }).providers;
    expect(providers.length).toBeGreaterThan(0);
    const target = providers[0]!.id;

    const patch = await deviceRequest(port, deviceToken, "PATCH", `/api/v1/providers/${target}`, {
      enabled: true,
    });
    expect(patch.status).toBe(200);

    // The masked keys list is fine (no values)…
    const keys = await deviceRequest(port, deviceToken, "GET", `/api/v1/providers/${target}/keys`);
    expect(keys.status).toBe(200);
    // …the REVEAL is not.
    const reveal = await deviceRequest(port, deviceToken, "POST", `/api/v1/providers/${target}/keys/reveal`);
    expect(reveal.status).toBe(403);
    expect((reveal.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("system/reset is desktop-only", async () => {
    const { deviceToken, port } = await pairDevice();
    const wipe = await deviceRequest(port, deviceToken, "POST", "/api/v1/system/reset");
    expect(wipe.status).toBe(403);
    expect((wipe.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("the internal dialogs and computer-use families are desktop-only", async () => {
    const { deviceToken, port } = await pairDevice();
    const dialog = await deviceRequest(port, deviceToken, "POST", "/api/v1/internal/dialog/folder", {
      purpose: "test",
    });
    expect(dialog.status).toBe(403);

    const computer = await deviceRequest(port, deviceToken, "GET", "/api/v1/computer-use/config");
    expect(computer.status).toBe(403);
  });

  it("the terminal families are desktop-only", async () => {
    const { deviceToken, port } = await pairDevice();
    // Any project id shape — the wall decides before the route's own 404s.
    const terminal = await deviceRequest(port, deviceToken, "POST", "/api/v1/projects/abc123/terminal", {
      command: "echo hi",
    });
    expect(terminal.status).toBe(403);

    const sessions = await deviceRequest(port, deviceToken, "GET", "/api/v1/projects/abc123/terminal-sessions");
    expect(sessions.status).toBe(403);
  });

  it("the SHELL token keeps full power on the blocked routes", async () => {
    const list = await shellInject("GET", "/api/v1/providers");
    const providers = (list.json() as { providers: { id: string; hasKey: boolean }[] }).providers;
    expect(list.statusCode).toBe(200);
    // The reveal route answers (200/ok:true or an honest no-key shape) —
    // never the 403 the device token gets.
    const target = providers.find((p) => p.hasKey)?.id ?? providers[0]!.id;
    const reveal = await shellInject("POST", `/api/v1/providers/${target}/keys/reveal`);
    expect(reveal.statusCode).not.toBe(403);

    const computer = await shellInject("GET", "/api/v1/computer-use/config");
    expect(computer.statusCode).not.toBe(403);
  });

  it("an unknown blocked-shaped path still 403s the device token (wall precedence)", async () => {
    const { deviceToken, port } = await pairDevice();
    const unknown = await deviceRequest(
      port,
      deviceToken,
      "GET",
      "/api/v1/computer-use/definitely-not-a-route",
    );
    expect(unknown.status).toBe(403);
  });

  it("a revoked token is plain 401 — the blocklist never leaks", async () => {
    const { deviceToken, port } = await pairDevice();
    const devices = await shellInject("GET", "/api/v1/mobile/devices");
    const rows = (devices.json() as { devices: { id: string }[] }).devices;
    expect(rows.length).toBe(1);
    const revoke = await shellInject("DELETE", `/api/v1/mobile/devices/${rows[0]!.id}`);
    expect(revoke.statusCode).toBe(200);
    const after = await deviceRequest(port, deviceToken, "GET", "/api/v1/providers");
    expect(after.status).toBe(401);
  });
});
