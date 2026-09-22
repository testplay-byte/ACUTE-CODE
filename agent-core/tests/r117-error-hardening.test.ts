// @vitest-environment node
//
// ROUND-117 (R117-e) — deliverables 5 + 6:
//
//   5. THE MESSAGE CONTENT CAP (262,144 chars) at all three ingress legs —
//      the streamed send (routes/sse.ts), the sync send + the queue POST
//      (routes/sessions.ts). Over-cap → the honest 400 VALIDATION naming
//      the exact bound; AT-cap passes (the generous long-prompt path).
//   6. NOTIFICATION FAILURES → THE DIAGNOSTICS RING: the bus's subscriber
//      failure path calls the INJECTABLE recorder (console.error stays the
//      belt), and the web-push fan-out catch in server.ts routes into the
//      ring (kind "notification") — plus the ring-side sink shape pin
//      (scrub + cap + the "—" method/url markers for non-HTTP entries).
//
// The full stack runs with ONLY the AI SDK mocked at the module boundary
// (the r78-queue pattern); lib/web-push's sendPushToAll is mocked to THROW
// for the fan-out failure leg.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));
const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn((_row: { name: string; baseURL: string }) => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
// R117-e deliverable 6: force the web-push fan-out to THROW so the
// server.ts catch (not the bus's belt) is the path under test.
vi.mock("../src/lib/web-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/web-push")>();
  return {
    ...actual,
    sendPushToAll: vi.fn(() => {
      throw new Error("push fanout exploded (fixture)");
    }),
  };
});

import { MESSAGE_CONTENT_CAP } from "../src/routes/sessions";
import { getNotificationBus } from "../src/lib/notification-bus";
import { recordDiagnostic, registerDiagnosticSink } from "../src/lib/diagnostics-sink";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { getTurnController, registerTurn, unregisterTurn } from "../src/lib/turn-registry";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r117e";
const KEY = "sk-or-vtest-r117e";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r117e-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // (The seeded default openrouter provider row already exists — the r78
  // suite's agents reference it directly.)
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
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

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A session through the storage layer (the r78 makeSession pattern). */
function makeSession(name: string): string {
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r117-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single" });
  return session.id;
}

function parseSse(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return frames;
}

/** The SDK-boundary stream shape the mocked streamText returns (r78). */
function sdkStream(
  parts: Array<Record<string, unknown>>,
  usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
    })(),
    totalUsage: Promise.resolve(usage),
    usage: Promise.resolve(usage),
  };
}

// ── deliverable 5: the content cap ──────────────────────────────────────────

describe("R117-e: the message content cap (262,144 chars, all three ingress legs)", () => {
  it("the bound is the documented 2^18 (the honest 400 names the exact number)", () => {
    expect(MESSAGE_CONTENT_CAP).toBe(262_144);
  });

  it("STREAM send: over-cap → 400 VALIDATION before the hijack; the message names the bound", async () => {
    const sessionId = makeSession("CapStream");
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "x".repeat(MESSAGE_CONTENT_CAP + 1) },
    });
    expect(response.statusCode).toBe(400);
    const error = response.json().error as { code: string; message: string; details: { field: string } };
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("content exceeds 262144 characters");
    expect(error.details.field).toBe("body.content");
    // Nothing was persisted and no turn started (the cap fires BEFORE the
    // concurrent-turn gate + hijack).
    expect(getTurnController(sessionId)).toBeUndefined();
  });

  it("STREAM send: AT-cap content passes validation and runs the turn (the generous long-prompt path)", async () => {
    const sessionId = makeSession("CapStreamAtCap");
    streamTextMock.mockImplementation(() =>
      sdkStream([{ type: "text-delta", text: "Done with the long prompt." }]),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "y".repeat(MESSAGE_CONTENT_CAP) },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    expect(frames.some((f) => f.type === "done")).toBe(true);
  });

  it("SYNC send: over-cap → 400 VALIDATION; at-cap passes validation (the unknown-session 404 proves it)", async () => {
    const over = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_unknown/messages",
      payload: { content: "x".repeat(MESSAGE_CONTENT_CAP + 1) },
    });
    expect(over.statusCode).toBe(400);
    expect((over.json().error as { message: string }).message).toBe("content exceeds 262144 characters");

    const atCap = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_unknown/messages",
      payload: { content: "y".repeat(MESSAGE_CONTENT_CAP) },
    });
    // The cap did NOT fire — validation passed and the turn layer answered
    // with its own honest unknown-session error instead.
    expect(atCap.statusCode).toBe(404);
    expect((atCap.json().error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("QUEUE POST: over-cap → 400 VALIDATION (a queued monster cannot bypass the send routes' cap)", async () => {
    const sessionId = makeSession("CapQueue");
    const controller = new AbortController();
    registerTurn(sessionId, controller);
    try {
      const over = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/queue`,
        payload: { content: "x".repeat(MESSAGE_CONTENT_CAP + 1) },
      });
      expect(over.statusCode).toBe(400);
      expect((over.json().error as { message: string }).message).toBe("content exceeds 262144 characters");
      expect((over.json().error as { details: { field: string } }).details.field).toBe("body.content");
    } finally {
      unregisterTurn(sessionId, controller);
    }
  });

  it("QUEUE POST: AT-cap content queues fine (200 {ok, seq})", async () => {
    const sessionId = makeSession("CapQueueAtCap");
    const controller = new AbortController();
    registerTurn(sessionId, controller);
    try {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/queue`,
        payload: { content: "y".repeat(MESSAGE_CONTENT_CAP) },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { ok: boolean; seq: number }).ok).toBe(true);
    } finally {
      unregisterTurn(sessionId, controller);
    }
  });
});

// ── deliverable 6: notification failures → the diagnostics ring ─────────────

describe("R117-e: the notification bus failure path calls the injectable recorder", () => {
  it("a throwing subscriber: console.error stays the belt AND the recorder fires with an honest message", () => {
    const bus = getNotificationBus();
    const recorded: string[] = [];
    bus.setFailureRecorder((message) => {
      recorded.push(message);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (): void => {
      throw new Error("toast rendering exploded");
    };
    const unsubscribe = bus.subscribe(boom);
    try {
      const record = bus.publish(db, {
        kind: "task_complete",
        title: "The task finished",
        body: "all good",
      });
      // publish NEVER throws into the caller (a turn must not fail because
      // a toast rendering threw) and still returns the durable record.
      expect(record.kind).toBe("task_complete");
      expect(record.title).toBe("The task finished");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain("notification-bus");
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toContain("notification delivery failed");
      expect(recorded[0]).toContain("task_complete");
      expect(recorded[0]).toContain(record.id);
      expect(recorded[0]).toContain("toast rendering exploded");
    } finally {
      unsubscribe();
      bus.setFailureRecorder(() => {});
      vi.restoreAllMocks();
    }
  });
});

describe("R117-e: web-push fan-out failures land in the diagnostics ring", () => {
  it("a throwing sendPushToAll → the server.ts catch records kind 'notification'; the ring row carries the sink shape", async () => {
    // This test needs the REAL server wiring (dataDir → the web-push
    // subscriber + the sink registration), so it builds its OWN app + db on
    // top of the beforeEach pair (the sink points at the LAST build — this
    // one — exactly the singleton-buses semantics).
    const dataDir = mkdtempSync(join(tempDir, "data-"));
    const pushDb = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const pushApp = buildServer({
      token: TOKEN,
      db: pushDb,
      dataDir,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
    try {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      // The durable record first (the bus's own publish path).
      const record = getNotificationBus().publish(pushDb, {
        kind: "task_failed",
        title: "The task failed",
        body: "it broke",
      });
      // The web-push subscriber's own catch fired (the belt line + the ring).
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0][0]).toContain("[web-push] fanout threw:");
      vi.restoreAllMocks();

      // The RING: GET /diagnostics/errors serves the entry to the Console.
      const response = await pushApp.inject({
        method: "GET",
        url: "/api/v1/diagnostics/errors",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const { errors } = response.json() as { errors: Record<string, unknown>[] };
      expect(errors).toHaveLength(1);
      const row = errors[0];
      expect(row.kind).toBe("notification");
      expect(row.source).toBe("sidecar");
      expect(row.statusCode).toBe(500);
      expect(row.code).toBe("INTERNAL");
      expect(row.method).toBe("—");
      expect(row.url).toBe("—");
      expect(String(row.message)).toContain("web-push fanout failed");
      expect(String(row.message)).toContain("push fanout exploded (fixture)");
      expect(row.count).toBe(1);
      // The exact field set the Console row renders (the R59-E contract).
      expect(Object.keys(row).sort()).toEqual(
        ["code", "count", "id", "kind", "message", "method", "source", "statusCode", "ts", "url"].sort(),
      );
      void record;
    } finally {
      await pushApp.close();
      pushDb.close();
    }
  });

  it("the module sink: recordDiagnostic scrubs + caps + routes through the registered ring (kind 'crash' shape)", async () => {
    const dataDir = mkdtempSync(join(tempDir, "data2-"));
    const sinkDb = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const sinkApp = buildServer({
      token: TOKEN,
      db: sinkDb,
      dataDir,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
    try {
      // Before any server builds the sink is a no-op — but a server JUST
      // built, so this write lands in ITS ring (the last build wins).
      recordDiagnostic("crash", "uncaughtException: Error: boom with Bearer abc123def456ghi789 inside");
      // A >2000-char message is capped at the registration side.
      recordDiagnostic("tool-shape", `z`.repeat(3_000));
      const response = await sinkApp.inject({
        method: "GET",
        url: "/api/v1/diagnostics/errors",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { errors } = response.json() as { errors: { kind: string; message: string }[] };
      expect(errors).toHaveLength(2);
      expect(errors[0].kind).toBe("tool-shape");
      expect(errors[0].message.length).toBeLessThan(2_100);
      expect(errors[0].message).toContain("truncated");
      expect(errors[1].kind).toBe("crash");
      expect(errors[1].message).toContain("Bearer ***");
      expect(errors[1].message).not.toContain("abc123def456ghi789");
    } finally {
      await sinkApp.close();
      sinkDb.close();
    }
  });
});

// Detach the module sink so later files (or a rerun) start clean.
afterAll(() => {
  registerDiagnosticSink(null);
});
