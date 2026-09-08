/**
 * ROUND-78 (R78) regression tests — the RETRY SETTINGS (the owner's
 * "General Settings 重试配置" ask) and the LADDER GATING they drive.
 *
 *  · RetrySettings storage: all-true defaults, get/set round-trip, invalid
 *    (non-boolean) patches throw, partial patches only write their own keys.
 *  · GET/PUT /settings/retry route: defaults, partial + full PUT round-trips,
 *    400 VALIDATION naming the offending body field, bearer wall.
 *  · The LADDER GATING in runStreamedAgentTurn (the r75-retry-ladder mock
 *    pattern — a fake chatStream that throws a 429 then succeeds):
 *      - autoRetryRateLimit=false → NO meta.retry frames, the terminal error
 *        carries attempts:1 and the REAL provider text (fail fast);
 *      - =true (default) → the meta.retry frame IS present and carries
 *        providerError with the real text (the live card shows what the API
 *        actually said).
 *  · The same gating for the timeout class (a TimeoutError with
 *    autoRetryTimeout=false fails fast).
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
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import {
  getRetrySettings,
  setRetrySettings,
  type RetrySettings,
} from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r78rs";
const KEY = "sk-or-vtest-r78rs";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r78rs-"));
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

/* ── Storage layer ─────────────────────────────────────────────────────────── */

describe("R78: RetrySettings storage", () => {
  it("defaults are all TRUE (the R75 ladder behavior is unchanged out of the box)", () => {
    expect(getRetrySettings(db)).toEqual({
      autoRetryRateLimit: true,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
    } satisfies RetrySettings);
  });

  it("get/set round-trips each switch; partial patches leave the others alone", () => {
    expect(setRetrySettings(db, { autoRetryRateLimit: false })).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
    });
    expect(setRetrySettings(db, { autoRetryTimeout: false, autoRetryNetwork: false })).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: false,
      autoRetryNetwork: false,
    });
    // A fresh read sees the same values (persisted, not just returned).
    expect(getRetrySettings(db)).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: false,
      autoRetryNetwork: false,
    });
    // Empty patch = no-op.
    expect(setRetrySettings(db, {})).toEqual(getRetrySettings(db));
  });

  it("non-boolean patches throw (the route maps this to 400 VALIDATION)", () => {
    expect(() => setRetrySettings(db, { autoRetryRateLimit: "no" as unknown as boolean })).toThrow(
      /autoRetryRateLimit must be a boolean/,
    );
    expect(() => setRetrySettings(db, { autoRetryTimeout: 1 as unknown as boolean })).toThrow(
      /autoRetryTimeout must be a boolean/,
    );
    expect(() => setRetrySettings(db, { autoRetryNetwork: null as unknown as boolean })).toThrow(
      /autoRetryNetwork must be a boolean/,
    );
  });
});

/* ── The routes (the /settings/debug pattern) ─────────────────────────────── */

describe("R78: GET/PUT /settings/retry", () => {
  it("GET returns the all-true defaults on a fresh database", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/settings/retry" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      autoRetryRateLimit: true,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
    });
  });

  it("PUT accepts a partial patch and returns the updated object; a GET rereads it", async () => {
    const off = await authInject({
      method: "PUT",
      url: "/api/v1/settings/retry",
      payload: { autoRetryRateLimit: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: true,
      autoRetryNetwork: true,
    });
    const reread = await authInject({ method: "GET", url: "/api/v1/settings/retry" });
    expect(reread.json()).toEqual(off.json());

    const allOff = await authInject({
      method: "PUT",
      url: "/api/v1/settings/retry",
      payload: { autoRetryRateLimit: false, autoRetryTimeout: false, autoRetryNetwork: false },
    });
    expect(allOff.json()).toEqual({
      autoRetryRateLimit: false,
      autoRetryTimeout: false,
      autoRetryNetwork: false,
    });
  });

  it("non-boolean values → 400 VALIDATION naming the body field", async () => {
    for (const [field, bad] of [
      ["autoRetryRateLimit", "yes"],
      ["autoRetryTimeout", 3],
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
  });

  it("a non-object body → 400; no bearer token → 401", async () => {
    const badBody = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/retry",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: JSON.stringify([1]),
    });
    expect(badBody.statusCode).toBe(400);
    const noAuth = await app.inject({ method: "GET", url: "/api/v1/settings/retry" });
    expect(noAuth.statusCode).toBe(401);
  });
});

/* ── The ladder gating (the r75 mock-chat pattern) ────────────────────────── */

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

/** A 429 with the REAL OpenRouter body the round was designed around. */
const rateLimitError = (): Error => new Error("Rate limit exceeded: free-models-per-day. Add 10 credits to get more");

function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r78-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

describe("R78: the ladder gating in runStreamedAgentTurn", () => {
  it("autoRetryRateLimit=false → NO meta.retry frames; the terminal error fails fast at attempts:1 with the REAL text", async () => {
    const { sessionId, keyring } = setup("R78-RateOff");
    setRetrySettings(db, { autoRetryRateLimit: false });
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      throw rateLimitError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    // Fail fast: exactly ONE provider call (no immediate-retry rung).
    expect(streamCalls).toBe(1);
    // No ladder frames ever emitted.
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(0);
    // The honest terminal outcome: attempts 1, the real class, real text.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.details?.attempts).toBe(1);
      expect(outcome.details?.errorClass).toBe("rate_limit");
      expect(String(outcome.details?.classMessage)).toContain("free-models-per-day");
      expect(String(outcome.details?.providerError)).toContain("free-models-per-day");
      expect(String(outcome.message)).not.toContain("auto-retry ladder exhausted");
    }
    // The persisted turn.error carries the same honest payload.
    const error = listSessionEvents(db, sessionId).find((e) => e.type === "turn.error");
    expect(error).toBeDefined();
    expect((error!.payload as Record<string, unknown>).attempts).toBe(1);
    expect(String((error!.payload as Record<string, unknown>).providerError)).toContain("free-models-per-day");
  });

  it("autoRetryRateLimit=true (the default) → the meta.retry frame IS present and carries providerError with the REAL text", async () => {
    const { sessionId, keyring } = setup("R78-RateOn");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) throw rateLimitError();
      yield { type: "text-delta", delta: "Recovered — the work is done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    const retryFrames = emitted.filter((e) => e.type === "meta.retry");
    expect(retryFrames).toHaveLength(1);
    expect(retryFrames[0]?.errorClass).toBe("rate_limit");
    // R78: the frame carries the REAL scrubbed provider text — the live
    // retry card shows what the API actually said.
    expect(String(retryFrames[0]?.providerError)).toContain("free-models-per-day");
    expect(String(retryFrames[0]?.classMessage)).toContain("free-models-per-day");
    // No error persisted — the immediate rung recovered.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("autoRetryTimeout=false → a TimeoutError fails fast (no ladder, attempts:1)", async () => {
    const { sessionId, keyring } = setup("R78-TimeoutOff");
    setRetrySettings(db, { autoRetryTimeout: false });
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      throw timeoutError;
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(streamCalls).toBe(1);
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.details?.attempts).toBe(1);
      expect(outcome.details?.errorClass).toBe("timeout");
    }
  });

  it("the per-class switches are independent — a 429 still ladders with only autoRetryNetwork off", async () => {
    const { sessionId, keyring } = setup("R78-Independent");
    setRetrySettings(db, { autoRetryNetwork: false });
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) throw rateLimitError();
      yield { type: "text-delta", delta: "Done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    // rate_limit is still ON → the ladder ran (2 calls, one retry frame).
    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(1);
  });
});
