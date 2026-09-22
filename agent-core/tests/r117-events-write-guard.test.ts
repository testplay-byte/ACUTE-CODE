// @vitest-environment node
//
// ROUND-117 (R117-e) — deliverable 4: the EVENTS ROUTE WRITE GUARD
// (routes/events.ts). The subscriber's res.write was previously unguarded:
// a destroyed watcher socket threw inside the bus subscriber — the bus's
// publish try/catch swallowed the throw, but the subscription + heartbeat
// SURVIVED, so every later frame re-threw and stderr collected the same
// dead-socket error forever. The guard (the sse.ts send() idiom): a failing
// write marks the stream dead and tears the subscription + heartbeat down
// immediately — the close handler stays the normal-path cleanup.
//
// Driving trick: app.inject({ payloadAsStream: true }) + a monkey-patched
// res.write that throws (the r113-events-stream suite's LiveBody pattern).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { getEventsBus } from "../src/lib/events-bus";
import { deviceLinkControllerFor } from "../src/lib/device-link";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r117events";
const KEY = "sk-or-vtest-r117events";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r117events-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    // No dataDir — hermetic (no web-push subscriber, no device link).
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
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

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payloadAsStream?: boolean;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** Flush microtasks until the predicate holds (real timers — the r113 settle). */
async function settle(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !predicate(); i += 1) {
    await Promise.resolve();
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  expect(predicate()).toBe(true);
}

describe("R117-e: the events-stream write guard", () => {
  it("a THROWING res.write (the destroyed-socket shape): no unhandled error, the subscription + heartbeat are torn down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const response = await authInject({
        method: "GET",
        url: "/api/v1/events/stream",
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      // (Hello already wrote through the REAL write — collect nothing; the
      // frames below are counted at the write-attempt level instead.)
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Make every subsequent write THROW — the exact shape of writing to a
      // destroyed socket. The counter increments BEFORE the throw so both the
      // old code's swallowed re-throws and the new guard's silence are
      // observable.
      const raw = response.raw.res;
      let writeAttempts = 0;
      raw.write = ((_chunk: unknown) => {
        writeAttempts += 1;
        throw new Error("write after destroy");
      }) as typeof raw.write;

      // PUBLISH #1 — the subscriber fires, the write throws, the guard
      // catches + unsubscribes. The publish itself never throws (no
      // unhandled error — and now neither does the subscriber keep dying).
      expect(() => getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "one" })).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeAttempts).toBe(1);

      // PUBLISH #2 — the subscription is GONE: the patched write is never
      // reached again (pre-R117 this re-threw inside the bus on every frame).
      getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "two" });
      await vi.advanceTimersByTimeAsync(0);
      expect(writeAttempts).toBe(1);

      // THE HEARTBEAT died with the teardown: 30 s of ticks produce ZERO
      // further write attempts (pre-R117 every 10 s ping re-threw — the
      // same dead-socket error forever).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(writeAttempts).toBe(1);

      response.raw.res.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ENDED response (writableEnded): the guard unsubscribes without a write attempt and without a throw", async () => {
    const response = await authInject({
      method: "GET",
      url: "/api/v1/events/stream",
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const raw = response.raw.res;
    let writeAttempts = 0;
    raw.write = ((_chunk: unknown) => {
      writeAttempts += 1;
      return true;
    }) as typeof raw.write;
    // Graceful end — writableEnded flips true.
    raw.end();

    // A frame published to the ended stream: no throw, no write attempt,
    // and the subscription is dropped (a second publish also stays silent).
    expect(() => getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "late" })).not.toThrow();
    await settle(() => true, 1);
    expect(writeAttempts).toBe(0);
    getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "later" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeAttempts).toBe(0);
  });

  it("a HEALTHY stream is unaffected: hello + live frames still land on the wire", async () => {
    const response = await authInject({
      method: "GET",
      url: "/api/v1/events/stream",
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    const chunks: string[] = [];
    response.stream().on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
    });
    const frames = () => chunks.join("").split("\n\n").filter((b) => b.startsWith("data: "));
    await settle(() => frames().length === 1);
    expect(frames()[0]).toBe('data: {"type":"hello"}');
    getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "live" });
    await settle(() => frames().length === 2);
    expect(frames()[1]).toBe('data: {"type":"turn","sessionId":"sess_x","frame":{"type":"text-delta","text":"live"}}');
    response.raw.res.destroy();
  });
});
