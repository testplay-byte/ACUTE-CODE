/**
 * ROUND-80 (R80, owner: "in the settings retry customization is needed"):
 * the CUSTOMIZABLE RETRY SCHEDULE — resolution, storage, routes, and the
 * ladder actually following the owner's settings.
 *
 *  · resolveRetrySchedule: the R75 defaults out of the box; custom
 *    maxAttempts/waitMinutes honored; out-of-bounds values fall back
 *    rung-by-rung (a corrupt row can never produce a broken ladder);
 *    the provider timeout resolves and bounds-checks.
 *  · describeRetrySchedule: the human phrasing for the notification body.
 *  · RetrySettings storage: the new fields round-trip; invalid patches
 *    throw (maxAttempts/waitMinutes/providerTimeoutSeconds bounds).
 *  · PUT /settings/retry: 400 VALIDATION naming the offending field.
 *  · THE LADDER FOLLOWS THE SETTINGS: a 3-attempt schedule retries exactly
 *    twice then succeeds (meta.retry frames carry totalAttempts: 3); a
 *    2-attempt schedule exhausts after one retry (terminal error carries
 *    attempts: 2).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(),
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import {
  resolveRetrySchedule,
  describeRetrySchedule,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_WAIT_MINUTES,
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
} from "../src/lib/retry";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { getRetrySettings, setRetrySettings, type RetrySettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r80rs";
const KEY = "sk-or-vtest-r80rs";
let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r80rs-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
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

/* ── The resolver (pure) ─────────────────────────────────────────────────── */

describe("R80: resolveRetrySchedule", () => {
  it("the R75 defaults out of the box (byte-identical pre-R80 behavior)", () => {
    const schedule = resolveRetrySchedule({});
    expect(schedule.totalAttempts).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
    expect(schedule.ladderMs).toEqual([0, 90_000, 300_000, 600_000, 1_800_000]);
    expect(schedule.timeoutMs).toBe(DEFAULT_PROVIDER_TIMEOUT_SECONDS * 1000);
  });

  it("a custom schedule is honored: maxAttempts + per-rung waits + timeout", () => {
    const schedule = resolveRetrySchedule({
      maxAttempts: 4,
      waitMinutes: [0, 0.5, 12],
      providerTimeoutSeconds: 120,
    });
    expect(schedule.totalAttempts).toBe(4);
    expect(schedule.ladderMs).toEqual([0, 30_000, 720_000]);
    expect(schedule.timeoutMs).toBe(120_000);
  });

  it("out-of-bounds values fall back (never a broken ladder)", () => {
    // maxAttempts out of bounds → the default 6.
    expect(resolveRetrySchedule({ maxAttempts: 1 }).totalAttempts).toBe(6);
    expect(resolveRetrySchedule({ maxAttempts: 99 }).totalAttempts).toBe(6);
    expect(resolveRetrySchedule({ maxAttempts: "six" as unknown as number }).totalAttempts).toBe(6);
    // Each rung falls back rung-by-rung: a bad entry becomes the default rung.
    const schedule = resolveRetrySchedule({ waitMinutes: [0, -5, 7] });
    expect(schedule.ladderMs[0]).toBe(0);
    expect(schedule.ladderMs[1]).toBe(90_000); // -5 rejected → the default rung
    expect(schedule.ladderMs[2]).toBe(420_000); // 7 min honored
    // A shorter array pads with the default rungs.
    const padded = resolveRetrySchedule({ waitMinutes: [1] });
    expect(padded.ladderMs).toEqual([60_000, 90_000, 300_000, 600_000, 1_800_000]);
    // The timeout clamps to its bounds via fallback.
    expect(resolveRetrySchedule({ providerTimeoutSeconds: 1 }).timeoutMs).toBe(600_000);
    expect(resolveRetrySchedule({ providerTimeoutSeconds: 99999 }).timeoutMs).toBe(600_000);
  });

  it("a 10-attempt schedule extends the default tail with 30-min rungs", () => {
    const schedule = resolveRetrySchedule({ maxAttempts: 10 });
    expect(schedule.ladderMs).toHaveLength(9);
    expect(schedule.ladderMs[5]).toBe(1_800_000);
    expect(schedule.ladderMs[8]).toBe(1_800_000);
  });

  it("describeRetrySchedule phrases the schedule the owner configured", () => {
    expect(describeRetrySchedule(resolveRetrySchedule({}))).toBe(
      "immediately, 1.5 min, 5 min, 10 min, 30 min",
    );
    // maxAttempts 3 = TWO rungs (the third waitMinutes entry is unused).
    expect(
      describeRetrySchedule(resolveRetrySchedule({ maxAttempts: 3, waitMinutes: [0, 0.5, 2] })),
    ).toBe("immediately, 30 s");
    expect(describeRetrySchedule(resolveRetrySchedule({ maxAttempts: 4, waitMinutes: [0, 0.5, 2] }))).toBe(
      "immediately, 30 s, 2 min",
    );
  });
});

/* ── The storage ─────────────────────────────────────────────────────────── */

describe("R80: RetrySettings storage (the schedule fields)", () => {
  it("the new fields round-trip; a partial patch leaves the booleans alone", () => {
    expect(setRetrySettings(db, { maxAttempts: 3, waitMinutes: [0, 0.5, 20], providerTimeoutSeconds: 300 })).toEqual({
      autoRetryRateLimit: true,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
      maxAttempts: 3,
      waitMinutes: [0, 0.5, 20],
      providerTimeoutSeconds: 300,
    } satisfies RetrySettings);
    expect(setRetrySettings(db, { autoRetryRateLimit: false })).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
      maxAttempts: 3,
      waitMinutes: [0, 0.5, 20],
      providerTimeoutSeconds: 300,
    } satisfies RetrySettings);
    // A fresh read sees the same values.
    expect(getRetrySettings(db).waitMinutes).toEqual([0, 0.5, 20]);
  });

  it("invalid patches throw (the route maps these to 400 VALIDATION)", () => {
    expect(() => setRetrySettings(db, { maxAttempts: 1 })).toThrow(/maxAttempts must be an integer between 2 and 10/);
    expect(() => setRetrySettings(db, { maxAttempts: 11 })).toThrow(/maxAttempts/);
    expect(() => setRetrySettings(db, { maxAttempts: 2.5 })).toThrow(/maxAttempts/);
    expect(() => setRetrySettings(db, { waitMinutes: [] })).toThrow(/waitMinutes must be an array of 1 to 9 numbers/);
    expect(() => setRetrySettings(db, { waitMinutes: [0, -1] })).toThrow(/waitMinutes entries/);
    expect(() => setRetrySettings(db, { waitMinutes: [0, 2000] })).toThrow(/waitMinutes entries/);
    expect(() => setRetrySettings(db, { waitMinutes: [0, "soon" as unknown as number] })).toThrow(/waitMinutes entries/);
    expect(() => setRetrySettings(db, { providerTimeoutSeconds: 30 })).toThrow(/providerTimeoutSeconds must be an integer between 60 and 3600/);
    expect(() => setRetrySettings(db, { providerTimeoutSeconds: 7200 })).toThrow(/providerTimeoutSeconds/);
  });

  it("a corrupt waitMinutes row reads back as the defaults (readWaitMinutes is defensive)", () => {
    setRetrySettings(db, { waitMinutes: [0, 1, 2] });
    // Hand-corrupt the row (the corrupt-DB path).
    db.prepare("UPDATE settings SET value = ? WHERE key = 'retry.waitMinutes'").run("not json");
    expect(getRetrySettings(db).waitMinutes).toEqual([...DEFAULT_RETRY_WAIT_MINUTES]);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'retry.waitMinutes'").run(JSON.stringify([0, "bad", 99999]));
    const read = getRetrySettings(db).waitMinutes;
    expect(read[0]).toBe(0);
    expect(read[1]).toBe(1.5); // "bad" → the default rung
    expect(read[2]).toBe(5); // 99999 out of bounds → the default rung
  });
});

/* ── The routes ──────────────────────────────────────────────────────────── */

describe("R80: GET/PUT /settings/retry (the schedule fields)", () => {
  it("PUT round-trips the schedule; a GET rereads it", async () => {
    const response = await authInject({
      method: "PUT",
      url: "/api/v1/settings/retry",
      payload: { maxAttempts: 4, waitMinutes: [0, 0.25, 6, 45], providerTimeoutSeconds: 900 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      autoRetryRateLimit: true,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
      maxAttempts: 4,
      waitMinutes: [0, 0.25, 6, 45],
      providerTimeoutSeconds: 900,
    });
    const reread = await authInject({ method: "GET", url: "/api/v1/settings/retry" });
    expect(reread.json()).toEqual(response.json());
  });

  it("out-of-bounds values → 400 VALIDATION naming the offending body field", async () => {
    for (const [field, bad] of [
      ["maxAttempts", 1],
      ["maxAttempts", 2.5],
      ["providerTimeoutSeconds", 10],
    ] as const) {
      const response = await authInject({
        method: "PUT",
        url: "/api/v1/settings/retry",
        payload: { [field]: bad },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe(`body.${field}`);
    }
    const badArray = await authInject({
      method: "PUT",
      url: "/api/v1/settings/retry",
      payload: { waitMinutes: [0, -3] },
    });
    expect(badArray.statusCode).toBe(400);
    expect(badArray.json().error.details.field).toBe("body.waitMinutes");
  });
});

/* ── The ladder FOLLOWS the settings (the runtime threading) ─────────────── */

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

function rateLimitError(): Error {
  // R105-C note: deliberately a NON-quota rate body ("rate limit exceeded",
  // no allocation wording) — this fixture's job is to pin the SETTINGS-
  // driven rungs (0 ms / 0.01 min), and a quota-shaped body would floor
  // both rungs at the 10-minute R105-C quota floor (see
  // tests/r105-rate-limit-reason.test.ts for that path's coverage).
  const err = new Error("429 Too Many Requests: rate limit exceeded");
  (err as Error & { statusCode?: number }).statusCode = 429;
  return err;
}

describe("R80: the retry ladder follows the customized schedule", () => {
  it("maxAttempts 3 → exactly two retries then success; the frames carry totalAttempts 3", async () => {
    const project = createProject(db, { name: "R80-Sched3", rootPath: join(tempDir, "R80-Sched3") });
    const agent = createAgent(db, { name: "R80 Sched3 Agent", providerId: "openrouter", model: "test/r80-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    setRetrySettings(db, { maxAttempts: 3, waitMinutes: [0, 0.01] });

    let calls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      if (calls <= 2) throw rateLimitError();
      yield { type: "text-delta", delta: "recovered" };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    };

    const emitted: Array<Record<string, unknown>> = [];
    const outcome = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: summarizerChat, chatStream },
      session.id,
      "hello",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(3);
    const retries = emitted.filter((e) => e.type === "meta.retry");
    expect(retries).toHaveLength(2);
    expect(retries.every((r) => r.totalAttempts === 3)).toBe(true);
    // The wait rungs come from the SETTINGS: rung 1 = 0 ms, rung 2 = 0.01 min.
    expect(retries[0]?.waitMs).toBe(0);
    expect(retries[1]?.waitMs).toBe(600);
  });

  it("maxAttempts 2 → one retry then the honest terminal error carries attempts: 2", async () => {
    const project = createProject(db, { name: "R80-Sched2", rootPath: join(tempDir, "R80-Sched2") });
    const agent = createAgent(db, { name: "R80 Sched2 Agent", providerId: "openrouter", model: "test/r80-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    setRetrySettings(db, { maxAttempts: 2, waitMinutes: [0] });

    let calls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      throw rateLimitError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: summarizerChat, chatStream },
      session.id,
      "hello",
      () => {},
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Two calls total (the initial + the single custom rung).
      expect(calls).toBe(2);
      expect(outcome.details?.attempts).toBe(2);
    }
    const events = listSessionEvents(db, session.id);
    const turnError = events.find((ev) => ev.type === "turn.error");
    expect((turnError?.payload as { attempts?: number }).attempts).toBe(2);
  });
});
