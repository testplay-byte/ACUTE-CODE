/**
 * ROUND-92 (R92-D, the owner's multi-key pool with automatic juggling):
 *
 *   "For the subagents in the same models and providers, the user can add
 *    more than one API key for a specific provider. Those API keys will be
 *    juggled between each other. If one API key fails, then it will
 *    automatically try the next API key in line and so forth. These API keys
 *    will be used for the subagents too."
 *
 * Coverage:
 *  · resolveKeyPool (the unit): dedupe by VALUE (same key in two slots = one
 *    entry, first slot wins), slot order, empties dropped.
 *  · (a) 429 from key 1 → IMMEDIATE swap to key 2 → success; usage attributed
 *    to the SWAPPED key's slot; the streamed twin emits the meta.key frame
 *    and NO meta.retry (the swap preempted the ladder).
 *  · (b) 401 → swap → success (auth is key-attributable for SWAPPING even
 *    though it never ladders).
 *  · (c) pool EXHAUSTED on auth → fail fast: every key tried once, terminal
 *    502 with errorClass auth, attempts 1 (the ladder never engages).
 *  · (d) pool EXHAUSTED on rate_limit → the R75 ladder engages with the
 *    ORIGINAL key; each rung re-burns the pool (12 calls for a 2-key pool
 *    over the 6-attempt default schedule); terminal attempts 6.
 *  · (e) keyCount on GET /providers: 0 when keyless, N after dedupe.
 *  · (f) POST /internal/providers/keys with `slot` (the 1-c Rust contract):
 *    the pool slot lands in the running sidecar's keyring; a subsequent
 *    turn finds it (a slot-only pool works — no primary needed); slot 0
 *    aliases the primary path; garbage slots 400; delete clears.
 *  · (g) the orchestrator de-special-casing: children share the PARENT
 *    keyring (the per-child single-key view is gone) — a child's reserved
 *    key failure juggles inside the child turn; no primary bias (a lone
 *    child starts on slot 0); concurrent children spread across slots when
 *    perKeyLimit forces it; usage attribution follows the ACTUALLY used key.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, ChatTurnOutput, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { Orchestrator } from "../src/agents/orchestrator";
import { ProviderKeyring, resolveKeyPool } from "../src/providers/registry";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { setOrchestrationSettings } from "../src/storage/settings";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const KEY1 = "sk-or-primary-r92"; // slot 0
const KEY2 = "sk-or-slot2-r92"; // slot 2 (the launcher's convention)
const KEY3 = "sk-or-slot3-r92"; // slot 3
const TOKEN = "test-token-r92";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r92pool-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** The three-key pool the shell would inject (primary + SLOT2 + SLOT3). */
function poolKeyring(): ProviderKeyring {
  return new ProviderKeyring({
    ACUTE_PROVIDER_OPENROUTER: KEY1,
    ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2,
    ACUTE_PROVIDER_OPENROUTER_SLOT3: KEY3,
  });
}

/** A session on the seeded openrouter provider (project → full turn path). */
function setup(name: string): { sessionId: string } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r92-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id };
}

/** A ChatFn spy recording the API KEY every call actually ran with. */
function spyChat(): {
  chat: ChatFn;
  keys: string[];
  /** Swap the behavior; `call` is the 1-based call number. */
  behave: (behavior: (call: number) => Promise<ChatTurnOutput>) => void;
} {
  const keys: string[] = [];
  let behavior: (call: number) => Promise<ChatTurnOutput> = async () => ({
    text: "pooled reply",
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    toolCalls: [],
  });
  const chat: ChatFn = async (input) => {
    keys.push(input.apiKey);
    return behavior(keys.length);
  };
  return { chat, keys, behave: (next) => (behavior = next) };
}

const rateLimitError = (): Error => new Error("429 Too Many Requests: rate limited on test/r92-1");
const authError = (): Error => {
  const err = new Error("401 Unauthorized: invalid API key");
  (err as Error & { statusCode?: number }).statusCode = 401;
  return err;
};

/** usage_events.key_slot for a session's (single) usage row. */
function usageSlotOf(sessionId: string): number | undefined {
  return (
    db.prepare("SELECT key_slot FROM usage_events WHERE session_id = ?").get(sessionId) as
      | { key_slot: number }
      | undefined
  )?.key_slot;
}

/* ── (g) unit: resolveKeyPool — the ONE pool derivation ───────────────────── */

describe("R92-D: resolveKeyPool (the deduped pool)", () => {
  it("keeps slot order and dedupes by VALUE — the same key in two slots is ONE entry", () => {
    const keyring = new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY1,
      ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY1, // duplicate VALUE, different slot
      ACUTE_PROVIDER_OPENROUTER_SLOT3: KEY3,
    });
    const pool = resolveKeyPool(keyring, "openrouter");
    expect(pool).toEqual([
      { slot: 0, key: KEY1 },
      { slot: 3, key: KEY3 },
    ]);
  });

  it("resolves [] for a provider with no keys at all", () => {
    expect(resolveKeyPool(new ProviderKeyring({}), "openrouter")).toEqual([]);
  });
});

/* ── The sync runner: (a) (b) (c) (d) ─────────────────────────────────────── */

describe("R92-D: the sync runner's key juggling", () => {
  it("(a) 429 on key 1 → IMMEDIATE swap to key 2 → success; usage attributed to slot 2", async () => {
    const { sessionId } = setup("R92-Sync-429");
    const spy = spyChat();
    spy.behave(async (call) => {
      if (call === 1) throw rateLimitError();
      return {
        text: "recovered on the second key",
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        toolCalls: [],
      };
    });

    const outcome = await runSingleAgentTurn({ db, keyring: poolKeyring(), chat: spy.chat }, sessionId, "do the work");

    expect(outcome.ok).toBe(true);
    expect(spy.keys).toEqual([KEY1, KEY2]); // the swap, with NO wait between
    // THE attribution pin: the spend lands on the key that actually served.
    expect(usageSlotOf(sessionId)).toBe(2);
    // No error ever persisted — the turn recovered.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("(b) 401 on key 1 → swap to key 2 → success (auth swaps, never ladders)", async () => {
    const { sessionId } = setup("R92-Sync-401");
    const spy = spyChat();
    spy.behave(async (call) => {
      if (call === 1) throw authError();
      return {
        text: "recovered after the auth swap",
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        toolCalls: [],
      };
    });

    const outcome = await runSingleAgentTurn({ db, keyring: poolKeyring(), chat: spy.chat }, sessionId, "do the work");

    expect(outcome.ok).toBe(true);
    expect(spy.keys).toEqual([KEY1, KEY2]);
    expect(usageSlotOf(sessionId)).toBe(2);
  });

  it("(c) pool EXHAUSTED on auth → fail fast: every key tried once, terminal auth, NO ladder", async () => {
    const { sessionId } = setup("R92-Sync-AuthDead");
    const spy = spyChat();
    spy.behave(async () => {
      throw authError();
    });

    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY1, ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2 }), chat: spy.chat },
      sessionId,
      "doomed work",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.details?.errorClass).toBe("auth");
      // Auth never ladders — and the key swaps did not inflate `attempts`.
      expect(outcome.details?.attempts).toBe(1);
    }
    expect(spy.keys).toEqual([KEY1, KEY2]); // both keys got their one shot
    const events = listSessionEvents(db, sessionId);
    const error = events.find((e) => e.type === "turn.error");
    expect(error).toBeDefined();
    expect((error!.payload as Record<string, unknown>).errorClass).toBe("auth");
  });

  it("(d) pool EXHAUSTED on rate_limit → the R75 ladder engages with the ORIGINAL key and re-burns the pool each rung", async () => {
    const { sessionId } = setup("R92-Sync-RateDead");
    const spy = spyChat();
    spy.behave(async () => {
      throw rateLimitError();
    });

    vi.useFakeTimers();
    try {
      const turnPromise = runSingleAgentTurn(
        { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY1, ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2 }), chat: spy.chat },
        sessionId,
        "doomed work",
      );
      // Advance the whole default ladder (immediate + 90s + 5min + 10min + 30min).
      await vi.advanceTimersByTimeAsync(90_000 + 300_000 + 600_000 + 1_800_000 + 5_000);
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(502);
        expect(outcome.details?.attempts).toBe(6); // the R75 schedule, unchanged
        expect(outcome.details?.errorClass).toBe("rate_limit");
        expect(String(outcome.message)).toContain("auto-retry ladder exhausted");
      }
      // 6 ladder attempts × 2 keys per rotation = 12 provider calls, and
      // the rotation restarted from the ORIGINAL key on every rung:
      // [K1, K2, K1, K2, …].
      expect(spy.keys).toHaveLength(12);
      expect(spy.keys.filter((_, i) => i % 2 === 0).every((k) => k === KEY1)).toBe(true);
      expect(spy.keys.filter((_, i) => i % 2 === 1).every((k) => k === KEY2)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── The streamed runner: the meta.key frame ──────────────────────────────── */

describe("R92-D: the streamed runner's key juggling (meta.key frame)", () => {
  it("(a) 429 on key 1 → swap to key 2 → success: one meta.key frame, no ladder, usage on slot 2", async () => {
    const { sessionId } = setup("R92-Stream-429");
    const emitted: Array<Record<string, unknown>> = [];
    const seenKeys: string[] = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      seenKeys.push(input.apiKey);
      if (streamCalls === 1) throw rateLimitError();
      yield { type: "text-delta", delta: "Recovered on the second key." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: poolKeyring(), chat: spyChat().chat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    expect(seenKeys).toEqual([KEY1, KEY2]);
    // THE frame: meta.key, mirroring meta.retry's shape — indexes + reason
    // only, NEVER a key value.
    const keyFrames = emitted.filter((e) => e.type === "meta.key");
    expect(keyFrames).toEqual([
      {
        type: "meta.key",
        sessionId,
        key: { attempt: 2, totalKeys: 3, reason: "rate_limit" },
        message: expect.stringContaining("switching to API key 2 of 3"),
      },
    ]);
    // The swap preempted the ladder — no meta.retry frames at all.
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(0);
    // No key VALUE ever rides the wire.
    expect(JSON.stringify(emitted)).not.toContain(KEY1);
    expect(JSON.stringify(emitted)).not.toContain(KEY2);
    expect(usageSlotOf(sessionId)).toBe(2);
  });

  it("(b) 401 mid-pool → swap → the meta.key frame carries reason 'auth'", async () => {
    const { sessionId } = setup("R92-Stream-401");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) throw authError();
      yield { type: "text-delta", delta: "Recovered after the auth swap." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: poolKeyring(), chat: spyChat().chat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    const keyFrames = emitted.filter((e) => e.type === "meta.key");
    expect(keyFrames).toHaveLength(1);
    expect((keyFrames[0]?.key as Record<string, unknown>).reason).toBe("auth");
    expect(usageSlotOf(sessionId)).toBe(2);
  });
});

/* ── (e) keyCount on GET /providers ──────────────────────────────────────── */

describe("R92-D: GET /providers keyCount", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("(e) serves the DEDUPED pool size per provider — 0 when keyless", async () => {
    app = buildServer({ token: TOKEN, db, keyring: poolKeyring() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/providers",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const openrouter = (
      response.json().providers as Array<{ id: string; hasKey: boolean; keyCount: number }>
    ).find((p) => p.id === "openrouter");
    expect(openrouter?.hasKey).toBe(true);
    expect(openrouter?.keyCount).toBe(3); // primary + SLOT2 + SLOT3

    // Duplicate VALUE in two slots counts ONCE.
    const dupeApp = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY1,
        ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY1,
      }),
    });
    try {
      const dupe = await dupeApp.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const row = (
        dupe.json().providers as Array<{ id: string; hasKey: boolean; keyCount: number }>
      ).find((p) => p.id === "openrouter");
      expect(row?.keyCount).toBe(1);
    } finally {
      await dupeApp.close();
    }

    // Keyless → 0 (the pre-R92 world, honestly counted).
    const bareApp = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const bare = await bareApp.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const row = (
        bare.json().providers as Array<{ id: string; hasKey: boolean; keyCount: number }>
      ).find((p) => p.id === "openrouter");
      expect(row?.hasKey).toBe(false);
      expect(row?.keyCount).toBe(0);
    } finally {
      await bareApp.close();
    }
  });
});

/* ── (f) POST /internal/providers/keys with slot (the 1-c Rust contract) ─── */

describe("R92-D: POST /internal/providers/keys {slot} (the shell handoff)", () => {
  let app: FastifyInstance;
  let keyring: ProviderKeyring;

  beforeEach(() => {
    keyring = new ProviderKeyring({});
    app = buildServer({ token: TOKEN, db, keyring });
  });

  afterEach(async () => {
    await app.close();
  });

  async function inject(options: {
    method: "POST";
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse> {
    return (await app.inject({
      ...options,
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as LightMyRequestResponse;
  }

  it("(f) a slot-scoped set lands in the running keyring — a later turn runs on it (a slot-only pool works)", async () => {
    // The 1-c payload: providerId + slot ≥ 1 + keyName "pool" + action set.
    const push = await inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", slot: 2, keyName: "pool", value: KEY2, action: "set" },
    });
    expect(push.statusCode).toBe(204);
    expect(keyring.getSlot("openrouter", 2)).toBe(KEY2);

    // A subsequent turn FINDS the key: the pool is slot-only (no primary) and
    // the runner starts from pool[0] — the SLOT2 entry.
    const { sessionId } = setup("R92-Internal-Slot");
    const spy = spyChat();
    const outcome = await runSingleAgentTurn({ db, keyring, chat: spy.chat }, sessionId, "hello");
    expect(outcome.ok).toBe(true);
    expect(spy.keys).toEqual([KEY2]);
    expect(usageSlotOf(sessionId)).toBe(2);

    // The listing serves the updated count.
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/providers",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const row = (
      listed.json().providers as Array<{ id: string; keyCount: number }>
    ).find((p) => p.id === "openrouter");
    expect(row?.keyCount).toBe(1);
  });

  it("slot 0 (and an absent slot) keeps the LEGACY primary path", async () => {
    const zero = await inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", slot: 0, value: KEY1, action: "set" },
    });
    expect(zero.statusCode).toBe(204);
    expect(keyring.get("openrouter")).toBe(KEY1);

    keyring.set("openrouter", "");
    const absent = await inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", value: KEY1, action: "set" },
    });
    expect(absent.statusCode).toBe(204);
    expect(keyring.get("openrouter")).toBe(KEY1);
  });

  it("400s garbage slots (non-integer, string, negative, > 31) without touching the keyring", async () => {
    for (const slot of [1.5, "2", -1, 32]) {
      const response = await inject({
        method: "POST",
        url: "/internal/providers/keys",
        payload: { providerId: "openrouter", slot, value: "x", action: "set" },
      });
      expect(response.statusCode, `slot ${String(slot)}`).toBe(400);
      expect(response.json().error.details.field).toBe("body.slot");
    }
    expect(keyring.getSlot("openrouter", 2)).toBeUndefined();
    expect(keyring.get("openrouter")).toBeUndefined();
  });

  it("action 'delete' clears the named slot symmetrically", async () => {
    await inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", slot: 2, keyName: "pool", value: KEY2, action: "set" },
    });
    const del = await inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", slot: 2, value: "sentinel", action: "delete" },
    });
    expect(del.statusCode).toBe(204);
    expect(keyring.getSlot("openrouter", 2)).toBeUndefined();
    // The pool is empty again → a turn now 409s with the R92 message.
    const { sessionId } = setup("R92-Internal-Delete");
    const outcome = await runSingleAgentTurn({ db, keyring, chat: spyChat().chat }, sessionId, "hello");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.code).toBe("CONFLICT");
      expect(outcome.message).toContain("no API key for provider 'openrouter'");
      expect(outcome.message).toContain("Settings → Models & Providers");
    }
  });
});

/* ── (g) the orchestrator: children share the parent pool ────────────────── */

describe("R92-D: orchestrator children share the PARENT keyring (views gone)", () => {
  it("a lone child starts on the PRIMARY (slot 0) — the ROUND-36 non-primary bias is gone", async () => {
    const agent = createAgent(db, { name: "Main", providerId: "openrouter", model: "test/r92-1" });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const spy = spyChat();

    const result = await new Orchestrator().delegateTask(
      { db, keyring: poolKeyring(), chat: spy.chat },
      parent.id,
      "lone child",
      "researcher",
    );

    expect(result.ok, `child failed: ${result.output}`).toBe(true);
    // Pre-R92 the child preferred slot 2 (the non-primary bias); R92's one
    // pool serves everyone — least-loaded, lowest slot → the primary.
    expect(spy.keys).toEqual([KEY1]);
    expect(usageSlotOf(result.sessionId!)).toBe(0);
  });

  it("concurrent children spread across slots when perKeyLimit forces it (load-spreading survives)", async () => {
    setOrchestrationSettings(db, { perKeyLimit: 1 });
    const agent = createAgent(db, { name: "Main", providerId: "openrouter", model: "test/r92-1" });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const spy = spyChat();
    const deps = { db, keyring: poolKeyring(), chat: spy.chat };
    // ONE orchestrator (the semaphores are per-instance — the sidecar's
    // singleton shape).
    const orchestrator = new Orchestrator();

    // The reservations happen synchronously at call time: child 1 takes
    // slot 0; child 2 sees slot 0 at its per-key limit → slot 2.
    const first = orchestrator.delegateTask(deps, parent.id, "first task", "researcher");
    const second = orchestrator.delegateTask(deps, parent.id, "second task", "researcher");
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok, `child 1 failed: ${r1.output}`).toBe(true);
    expect(r2.ok, `child 2 failed: ${r2.output}`).toBe(true);
    expect(spy.keys.sort()).toEqual([KEY1, KEY2].sort());
    // Each child's spend attributes to ITS reserved slot (load-spreading is
    // the STARTING key — the juggling would follow any failure from there).
    expect(usageSlotOf(r1.sessionId!)).toBe(0);
    expect(usageSlotOf(r2.sessionId!)).toBe(2);
  });

  it("a child whose reserved key 429s JUGGLES inside its own turn (the owner's subagent requirement)", async () => {
    const agent = createAgent(db, { name: "Main", providerId: "openrouter", model: "test/r92-1" });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const spy = spyChat();
    spy.behave(async (call) => {
      if (call === 1) throw rateLimitError();
      return {
        text: "child recovered on the second key",
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        toolCalls: [],
      };
    });

    const result = await new Orchestrator().delegateTask(
      { db, keyring: poolKeyring(), chat: spy.chat },
      parent.id,
      "juggling child",
      "researcher",
    );

    expect(result.ok, `child failed: ${result.output}`).toBe(true);
    expect(spy.keys).toEqual([KEY1, KEY2]); // the child saw the WHOLE pool
    // The swap is attributed: the second key's slot served the child.
    expect(usageSlotOf(result.sessionId!)).toBe(2);
  });
});
