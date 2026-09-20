/**
 * ROUND-115 (R115-E2, the pairing round) — the WORD-PAIR MACHINE NAME +
 * the device-sourced session-created frame:
 *
 *   1. mintMachineLabel — a random title-cased ADJECTIVE + NOUN pair from
 *      the two curated lists (family-friendly, clean English), never
 *      anything else.
 *   2. getMachineLabel — minted ONCE, persisted at
 *      `<dataDir>/machine-label.json` (the vapid.json/device-cert pattern),
 *      STABLE across "restarts" (cache reset + re-read); a corrupt file
 *      re-mints (never throws); the cache serves repeat calls.
 *   3. THE WIRE (all additive — v stays 1, every v1 field keeps its name):
 *      · POST /mobile/pair/start → `machineLabel` rides the QR payload;
 *      · GET /mobile/link-info → `machineLabel` rides the status;
 *      · POST /mobile/pair/claim (the phone's real TLS hop) → machine.name
 *        is the minted label (the phone stores it as its hostLabel).
 *   4. THE DEVICE-SOURCED SESSION — a POST /sessions authenticated with a
 *      DEVICE token publishes the "created" frame with source:"device";
 *      the SHELL token's own POST keeps the bare pre-R115 shape (no source
 *      key — old clients ignore it, new clients key off it).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { deviceLinkControllerFor } from "../src/lib/device-link";
import { getEventsBus, type EventsBusFrame } from "../src/lib/events-bus";
import {
  MACHINE_LABEL_ADJECTIVES,
  MACHINE_LABEL_FILENAME,
  MACHINE_LABEL_NOUNS,
  getMachineLabel,
  mintMachineLabel,
  resetMachineLabelForTest,
} from "../src/lib/machine-label";

const TOKEN = "shell-token-r115";
const ADJ = "Sunny";
const NOUN = "Meadow";

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r115-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir });
  // Every test re-reads its OWN dataDir's label file (the cache would
  // otherwise leak the previous test's machine name across data dirs).
  resetMachineLabelForTest();
});

afterEach(async () => {
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
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

/** Enable the device link (the TLS listener the claim ride needs). */
async function enableLink(): Promise<{ port: number }> {
  const put = await shellInject("PUT", "/api/v1/settings/device-link", { enabled: true });
  expect(put.statusCode).toBe(200);
  const link = deviceLinkControllerFor(app);
  const status = link?.status() ?? null;
  expect(status).not.toBeNull();
  return { port: (status as { port: number }).port };
}

/** pair/start → the QR payload (shell token). */
async function startPairing(): Promise<Record<string, unknown>> {
  const response = await shellInject("POST", "/api/v1/mobile/pair/start");
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

// ── 1. the mint ─────────────────────────────────────────────────────────────

describe("R115-E2: mintMachineLabel", () => {
  it("mints a title-cased adjective + noun pair from the curated lists", () => {
    for (let i = 0; i < 60; i += 1) {
      const label = mintMachineLabel();
      expect(label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      const [adjective, noun] = label.split(" ");
      expect(MACHINE_LABEL_ADJECTIVES).toContain(adjective);
      expect(MACHINE_LABEL_NOUNS).toContain(noun);
    }
  });

  it("the lists are ~24 clean words each, all distinct, all title-cased", () => {
    expect(MACHINE_LABEL_ADJECTIVES.length).toBe(24);
    expect(MACHINE_LABEL_NOUNS.length).toBe(24);
    expect(new Set(MACHINE_LABEL_ADJECTIVES).size).toBe(24);
    expect(new Set(MACHINE_LABEL_NOUNS).size).toBe(24);
    for (const word of [...MACHINE_LABEL_ADJECTIVES, ...MACHINE_LABEL_NOUNS]) {
      expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});

// ── 2. the persistence (mint once, stable across restarts) ──────────────────

describe("R115-E2: getMachineLabel (the machine-label.json pattern)", () => {
  it("mints once, persists beside vapid.json, and is STABLE across a cache reset (restart)", async () => {
    const first = await getMachineLabel(dataDir);
    expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    // The file exists with the exact label (the persisted shape).
    const persisted = JSON.parse(
      readFileSync(join(dataDir, MACHINE_LABEL_FILENAME), "utf8"),
    ) as { label: string };
    expect(persisted.label).toBe(first);
    // A "restart": drop the in-module cache, re-read the SAME dataDir.
    resetMachineLabelForTest();
    const second = await getMachineLabel(dataDir);
    expect(second).toBe(first);
  });

  it("serves the cache for repeat calls (no file churn) and honors a pre-seeded label", async () => {
    // A pre-seeded file (e.g. synced from a backup) wins — never re-minted.
    writeFileSync(
      join(dataDir, MACHINE_LABEL_FILENAME),
      `${JSON.stringify({ label: `${ADJ} ${NOUN}` })}\n`,
    );
    await expect(getMachineLabel(dataDir)).resolves.toBe(`${ADJ} ${NOUN}`);
    await expect(getMachineLabel(dataDir)).resolves.toBe(`${ADJ} ${NOUN}`);
  });

  it("re-mints on a corrupt file (never throws) and overwrites it", async () => {
    writeFileSync(join(dataDir, MACHINE_LABEL_FILENAME), "not json at all");
    const label = await getMachineLabel(dataDir);
    expect(label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const persisted = JSON.parse(
      readFileSync(join(dataDir, MACHINE_LABEL_FILENAME), "utf8"),
    ) as { label: string };
    expect(persisted.label).toBe(label);
  });

  it("re-mints when the persisted label is blank or oversize (the honest validation)", async () => {
    writeFileSync(join(dataDir, MACHINE_LABEL_FILENAME), `${JSON.stringify({ label: "   " })}\n`);
    const blank = await getMachineLabel(dataDir);
    expect(blank).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    resetMachineLabelForTest();
    writeFileSync(
      join(dataDir, MACHINE_LABEL_FILENAME),
      `${JSON.stringify({ label: "x".repeat(101) })}\n`,
    );
    const oversize = await getMachineLabel(dataDir);
    expect(oversize.length).toBeLessThanOrEqual(100);
  });
});

// ── 3. the wire: machineLabel on every pairing surface (ADDITIVE) ───────────

describe("R115-E2: the pairing surfaces carry machineLabel", () => {
  it("pair/start + link-info ride it additively (v stays 1, v1 fields intact)", async () => {
    await enableLink();
    const label = await getMachineLabel(dataDir);

    const qr = await startPairing();
    expect(qr.machineLabel).toBe(label);
    expect(qr.v).toBe(1);
    expect(typeof qr.pin).toBe("string");
    expect(Array.isArray(qr.addrs)).toBe(true);
    expect(typeof qr.port).toBe("number");
    expect(typeof qr.certFP).toBe("string");
    expect(typeof qr.machineId).toBe("string");
    expect(typeof qr.ttl).toBe("number");

    const info = await shellInject("GET", "/api/v1/mobile/link-info");
    expect(info.statusCode).toBe(200);
    const linkInfo = info.json() as Record<string, unknown>;
    expect(linkInfo.machineLabel).toBe(label);
    // The v1 status fields are untouched by the addition.
    expect(linkInfo.enabled).toBe(true);
    expect(typeof linkInfo.port).toBe("number");
  });

  it("the claim response's machine.name is the minted label (the phone's hostLabel)", async () => {
    await enableLink();
    const label = await getMachineLabel(dataDir);
    const qr = await startPairing();
    const claim = await tlsRequest((qr.port as number), "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: String(qr.pin), label: "the owner's phone" },
    });
    expect(claim.status).toBe(200);
    const claimed = claim.json as Record<string, unknown>;
    expect(claimed.machine).toMatchObject({ name: label });
    expect((claimed.machine as Record<string, unknown>).version).toEqual(expect.any(String));
    // The claim shape's own fields stay intact (additive here too).
    expect(Object.keys(claimed).sort()).toEqual(
      ["addrs", "certFP", "deviceId", "deviceToken", "machine", "port"].sort(),
    );
  });
});

// ── 4. the device-sourced session-created frame ─────────────────────────────

describe("R115-E2: the session-created frame's source field", () => {
  /** Pair a device through the real routes; returns its token. */
  async function pairDevice(): Promise<string> {
    await enableLink();
    const qr = await startPairing();
    const claim = await tlsRequest((qr.port as number), "POST", "/api/v1/mobile/pair/claim", {
      body: { pin: String(qr.pin), label: "the owner's phone" },
    });
    expect(claim.status).toBe(200);
    return (claim.json as { deviceToken: string }).deviceToken;
  }

  /** An agent row through the real route (POST /sessions needs one). */
  async function makeAgent(): Promise<string> {
    const res = await shellInject("POST", "/api/v1/agents", {
      name: "R115 Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/r115-1",
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("a DEVICE-token POST /sessions publishes kind:'created' with source:'device'", async () => {
    const deviceToken = await pairDevice();
    const agentId = await makeAgent();

    const frames: EventsBusFrame[] = [];
    const unsubscribe = getEventsBus().subscribe((f) => frames.push(f));
    try {
      // The phone's seat: the device token on the loopback inject (tokens
      // are transport-agnostic — the wall hashes the token, never the
      // address; the r106 wall suite pins this leg).
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: { agentId, mode: "single" },
      });
      expect(res.statusCode).toBe(202);
      const sessionId = (res.json() as { id: string }).id;

      const created = frames.find(
        (f): f is Extract<EventsBusFrame, { type: "session" }> =>
          f.type === "session" && f.kind === "created",
      );
      expect(created).toBeDefined();
      expect(created?.sessionId).toBe(sessionId);
      expect(created?.source).toBe("device");
      // JSON round-trip: the source key rides the WIRE (never undefined).
      expect(JSON.parse(JSON.stringify(created))).toMatchObject({
        type: "session",
        kind: "created",
        source: "device",
      });
    } finally {
      unsubscribe();
    }
  });

  it("a SHELL-token POST /sessions keeps the bare pre-R115 shape (no source key)", async () => {
    const agentId = await makeAgent();

    const frames: EventsBusFrame[] = [];
    const unsubscribe = getEventsBus().subscribe((f) => frames.push(f));
    try {
      const res = await shellInject("POST", "/api/v1/sessions", {
        agentId,
        mode: "single",
      });
      expect(res.statusCode).toBe(202);
      const sessionId = (res.json() as { id: string }).id;

      const created = frames.find(
        (f): f is Extract<EventsBusFrame, { type: "session" }> =>
          f.type === "session" && f.kind === "created",
      );
      expect(created).toBeDefined();
      expect(created?.sessionId).toBe(sessionId);
      // The additive contract: the key is ABSENT, never undefined.
      expect("source" in (created as Record<string, unknown>)).toBe(false);
      expect(JSON.parse(JSON.stringify(created))).toEqual({
        type: "session",
        sessionId,
        projectId: null,
        kind: "created",
        status: "queued",
      });
    } finally {
      unsubscribe();
    }
  });
});
